// Generates the FFI layer from DuckDB's C API spec (vendor/duckdb-api-spec/v1),
// the YAML that duckdb.h itself is generated from:
//
//   src/bindings/generated/capi.ts  the bun:ffi dlopen table of every C function,
//                                   the table of the shim's by-value wrappers,
//                                   and the C layout of every struct.
//   native/src/by_value.rs          the Rust wrappers for the C functions that
//                                   take or return a struct by value, which
//                                   bun:ffi cannot call (see native/ABI.md).
//
//   bun run gen:ffi

import { join } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const SPEC = join(ROOT, "vendor", "duckdb-api-spec", "v1");
const TS_OUT = join(ROOT, "src", "bindings", "generated", "capi.ts");
const RS_OUT = join(ROOT, "native", "src", "by_value.rs");

interface Param {
  type: string;
  indirection?: number;
  const?: boolean;
  kind?: "OUT";
}
interface Fn {
  lifecycle: [string, string, string][];
  parameters: Record<string, Param> | null;
  return_type: string;
  return_pointer?: number;
  return_const?: boolean;
}
interface Field {
  name: string;
  type: string;
  pointer?: number;
}
interface Module {
  functions?: Record<string, Fn>;
  structs?: Record<string, { fields: Field[] }>;
  enums?: Record<string, unknown>;
  aliases?: Record<string, { underlying: string }>;
  handles?: Record<string, unknown>;
  callbacks?: Record<string, unknown>;
}

const functions = new Map<string, Fn>();
const structs = new Map<string, Field[]>();
const enums = new Set<string>();
const handles = new Set<string>();
const callbacks = new Set<string>();
const aliases = new Map<string, string>();

const files = await Array.fromAsync(new Glob("**/*.yaml").scan(SPEC));
for (const file of files.sort()) {
  const spec = Bun.YAML.parse(await Bun.file(join(SPEC, file)).text()) as Module;
  for (const [name, fn] of Object.entries(spec.functions ?? {})) functions.set(name, fn);
  for (const [name, struct] of Object.entries(spec.structs ?? {})) structs.set(name, struct.fields);
  for (const name of Object.keys(spec.enums ?? {})) enums.add(name);
  for (const name of Object.keys(spec.handles ?? {})) handles.add(name);
  for (const name of Object.keys(spec.callbacks ?? {})) callbacks.add(name);
  for (const [name, alias] of Object.entries(spec.aliases ?? {})) aliases.set(name, alias.underlying);
}
if (functions.size === 0) throw new Error(`No functions found under ${SPEC}`);

// --- C scalar types -----------------------------------------------------------

/** Size and alignment of each scalar, for the LP64 targets we ship (linux-x64, darwin-arm64). */
const SCALARS: Record<string, { size: number; ffi: string; rust: string }> = {
  bool: { size: 1, ffi: "bool", rust: "bool" },
  char: { size: 1, ffi: "i8", rust: "c_char" },
  i8: { size: 1, ffi: "i8", rust: "i8" },
  i16: { size: 2, ffi: "i16", rust: "i16" },
  i32: { size: 4, ffi: "i32", rust: "i32" },
  i64: { size: 8, ffi: "i64", rust: "i64" },
  u8: { size: 1, ffi: "u8", rust: "u8" },
  u16: { size: 2, ffi: "u16", rust: "u16" },
  u32: { size: 4, ffi: "u32", rust: "u32" },
  u64: { size: 8, ffi: "u64", rust: "u64" },
  f32: { size: 4, ffi: "f32", rust: "f32" },
  f64: { size: 8, ffi: "f64", rust: "f64" },
  idx: { size: 8, ffi: "u64", rust: "idx_t" },
  size: { size: 8, ffi: "u64", rust: "usize" },
  state: { size: 4, ffi: "i32", rust: "duckdb_state" },
};

function resolve(type: string): string {
  return aliases.has(type) && !enums.has(type) ? resolve(aliases.get(type) as string) : type;
}

function isEnum(type: string): boolean {
  return enums.has(type) || enums.has(aliases.get(type) ?? "");
}

/** True for a type passed by value as a C struct (bun:ffi cannot). */
function isStruct(type: string): boolean {
  return structs.has(type) || type === "duckdb_string_t";
}

// --- struct layout ------------------------------------------------------------

interface Layout {
  size: number;
  align: number;
  fields: Record<string, { offset: number; type: string; size: number }>;
}
const layouts = new Map<string, Layout>();

function sizeAlign(type: string, pointer: number): { size: number; align: number } {
  if (pointer > 0) return { size: 8, align: 8 };
  const t = resolve(type);
  if (SCALARS[t]) return { size: SCALARS[t].size, align: SCALARS[t].size };
  if (isEnum(type)) return { size: 4, align: 4 };
  if (handles.has(t) || callbacks.has(t) || t === "opaque") return { size: 8, align: 8 };
  if (structs.has(t)) {
    const layout = layoutOf(t);
    return { size: layout.size, align: layout.align };
  }
  throw new Error(`No size known for type ${type}`);
}

function layoutOf(name: string): Layout {
  const known = layouts.get(name);
  if (known) return known;
  const fields: Layout["fields"] = {};
  let offset = 0;
  let align = 1;
  for (const field of structs.get(name) ?? []) {
    const { size, align: fieldAlign } = sizeAlign(field.type, field.pointer ?? 0);
    offset = Math.ceil(offset / fieldAlign) * fieldAlign;
    fields[field.name] = { offset, type: (field.pointer ?? 0) > 0 ? "ptr" : resolve(field.type), size };
    offset += size;
    align = Math.max(align, fieldAlign);
  }
  const layout = { size: Math.ceil(offset / align) * align, align, fields };
  layouts.set(name, layout);
  return layout;
}

// duckdb_string_t is a union the spec leaves to hand-written C: 16 bytes, 8-aligned.
layouts.set("duckdb_string_t", { size: 16, align: 8, fields: {} });
for (const name of structs.keys()) layoutOf(name);

// --- per-function classification ----------------------------------------------

function ffiType(type: string, indirection: number): string {
  if (indirection > 0) return "ptr";
  const t = resolve(type);
  if (SCALARS[t]) return SCALARS[t].ffi;
  if (isEnum(type)) return "i32";
  if (handles.has(t) || callbacks.has(t) || t === "opaque") return "ptr";
  throw new Error(`No FFI type for ${type}`);
}

function rustType(type: string, indirection: number, isConst: boolean): string {
  const t = resolve(type);
  let base: string;
  if (t === "opaque" || t === "void") base = "c_void";
  else if (SCALARS[t]) base = SCALARS[t].rust;
  else if (t === "duckdb_string_t") base = "duckdb_string_t";
  else if (t === "sel_t") base = "sel_t";
  else base = `duckdb_${type === "type" ? "type" : t}`;
  if (indirection === 0) return base;
  // Bindgen spells `const T *` as `*const T` and `T *` as `*mut T`; the const
  // qualifier the spec records applies to the innermost pointee.
  let out = `${isConst ? "*const" : "*mut"} ${base}`;
  for (let i = 1; i < indirection; i++) out = `*mut ${out}`;
  return out;
}

const direct: string[] = [];
const wrapped: string[] = [];
const rust: string[] = [];

for (const [name, fn] of [...functions].sort(([a], [b]) => a.localeCompare(b))) {
  const params = Object.entries(fn.parameters ?? {});
  const returnsStruct = (fn.return_pointer ?? 0) === 0 && isStruct(resolve(fn.return_type));
  const byValue = params.filter(([, p]) => (p.indirection ?? 0) === 0 && isStruct(resolve(p.type)));
  const returnFfi =
    returnsStruct || (fn.return_type === "opaque" && (fn.return_pointer ?? 0) === 0)
      ? "void"
      : ffiType(fn.return_type, fn.return_pointer ?? 0);

  if (!returnsStruct && byValue.length === 0) {
    const args = params.map(([, p]) => JSON.stringify(ffiType(p.type, p.indirection ?? 0)));
    direct.push(`  duckdb_${name}: { args: [${args.join(", ")}], returns: ${JSON.stringify(returnFfi)} },`);
    continue;
  }

  // Wrapper: by-value struct parameters become `*const T`, a by-value struct
  // return becomes a trailing `*mut T` out parameter.
  const args = params.map(([, p]) =>
    (p.indirection ?? 0) === 0 && isStruct(resolve(p.type))
      ? '"ptr"'
      : JSON.stringify(ffiType(p.type, p.indirection ?? 0)),
  );
  if (returnsStruct) args.push('"ptr"');
  wrapped.push(
    `  dbs_${name}: { args: [${args.join(", ")}], returns: ${JSON.stringify(returnsStruct ? "void" : returnFfi)} },`,
  );

  const rustParams = params.map(([pname, p]) => {
    const ind = p.indirection ?? 0;
    if (ind === 0 && isStruct(resolve(p.type))) return `${pname}: *const ${rustType(p.type, 0, false)}`;
    return `${pname}: ${rustType(p.type, ind, p.const ?? false)}`;
  });
  const retType = returnsStruct ? rustType(fn.return_type, 0, false) : null;
  if (retType) rustParams.push(`out: *mut ${retType}`);
  const rustReturn =
    returnsStruct || (fn.return_type === "opaque" && (fn.return_pointer ?? 0) === 0)
      ? ""
      : ` -> ${rustType(fn.return_type, fn.return_pointer ?? 0, fn.return_const ?? false)}`;
  const callArgs = params.map(([pname, p]) =>
    (p.indirection ?? 0) === 0 && isStruct(resolve(p.type)) ? `${pname}.read()` : pname,
  );
  const call = `duckdb_${name}(${callArgs.join(", ")})`;
  const structParams = byValue.map(([pname]) => `\`${pname}\``);
  const safety = [
    ...structParams.map((p) => `${p} points to a valid, initialized value`),
    ...(retType ? ["`out` points to writable memory for the result"] : []),
    "the other arguments satisfy the contract of the wrapped C function",
  ];
  rust.push(
    [
      `/// Wraps \`duckdb_${name}\`, passing by-value structs through pointers.`,
      "///",
      "/// # Safety",
      "///",
      `/// The caller guarantees that ${safety.join(", and ")}.`,
      "#[unsafe(no_mangle)]",
      `pub unsafe extern "C" fn dbs_${name}(${rustParams.join(", ")})${rustReturn} {`,
      `    // SAFETY: the caller upholds this function's contract, documented above.`,
      retType ? `    unsafe { out.write(${call}) }` : `    unsafe { ${call} }`,
      "}",
    ].join("\n"),
  );
}

// --- emit ---------------------------------------------------------------------

const layoutLines = [...layouts]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, l]) => {
    const fields = Object.entries(l.fields)
      .map(([f, v]) => `${f}: { offset: ${v.offset}, size: ${v.size}, type: ${JSON.stringify(v.type)} }`)
      .join(", ");
    return `  ${name}: { size: ${l.size}, align: ${l.align}, fields: { ${fields} } },`;
  });

const header = "Generated by scripts/gen-ffi.ts from vendor/duckdb-api-spec; do not edit.";
await Bun.write(
  TS_OUT,
  [
    `// ${header}`,
    "",
    "/** Every libduckdb C function bun:ffi can call directly, as a dlopen table. */",
    "export const capi = {",
    ...direct,
    "} as const;",
    "",
    "/** The shim's wrappers for C functions that take or return a struct by value (native/ABI.md). */",
    "export const byValue = {",
    ...wrapped,
    "} as const;",
    "",
    "/** The C layout of each spec struct on the shipped LP64 targets. */",
    "export const layouts = {",
    ...layoutLines,
    "} as const;",
    "",
  ].join("\n"),
);
await Bun.write(
  RS_OUT,
  [
    `// ${header}`,
    "//! By-value wrappers: one `dbs_<name>` per C function that takes or returns a",
    "//! struct by value, which bun:ffi cannot call directly (see native/ABI.md).",
    "",
    "use libduckdb_sys::*;",
    ...["c_char", "c_void"]
      .filter((t) => rust.some((line) => new RegExp(`\\b${t}\\b`).test(line)))
      .map((t) => `use std::ffi::${t};`),
    "",
    rust.join("\n\n"),
    "",
  ].join("\n"),
);
await Bun.$`rustfmt --edition 2024 ${RS_OUT}`;
await Bun.$`${join(ROOT, "node_modules", ".bin", "biome")} check --write ${TS_OUT}`.quiet();
console.log(`capi: ${direct.length} direct, ${wrapped.length} wrapped, ${layouts.size} struct layouts`);
