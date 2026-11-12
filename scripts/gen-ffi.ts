// Generates the FFI layer from DuckDB's C API spec (vendor/duckdb-api-spec/v1),
// the YAML that duckdb.h itself is generated from:
//
//   src/bindings/generated/capi.ts  the bun:ffi signature of every C function,
//                                   the functions that check the C++ exception
//                                   flag after each call, and the C layout of
//                                   every struct.
//   native/cpp/capi.cpp             a C++ wrapper per C function that catches a
//                                   C++ exception (native/cpp/boundary.hpp), with
//                                   by-value structs passed through pointers,
//                                   which bun:ffi cannot pass (native/ABI.md),
//                                   and the table of their addresses.
//
//   bun run gen:ffi

import { join } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");
const SPEC = join(ROOT, "vendor", "duckdb-api-spec", "v1");
const TS_OUT = join(ROOT, "src", "bindings", "generated", "capi.ts");
const CPP_OUT = join(ROOT, "native", "cpp", "capi.cpp");

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

const direct: string[] = [];
const wrapped: string[] = [];
/** TypeScript checking wrappers, for the direct and the by-value table. */
const guardDirect: string[] = [];
const guardWrapped: string[] = [];
/** C++ wrapper definitions, and their names in table order: direct ones first, then by-value ones. */
const cpp: string[] = [];
const cppDirect: string[] = [];
const cppWrapped: string[] = [];

/** A TypeScript wrapper that calls `name` and throws a pending C++ exception. */
function guard(name: string, arity: number): string {
  const args = Array.from({ length: arity }, (_, i) => `a${i}`).join(", ");
  return `    ${name}: (${args}) => {\n      const r = raw.${name}(${args});\n      if (failed[0] !== 0) raise();\n      return r;\n    },`;
}

for (const [name, fn] of [...functions].sort(([a], [b]) => a.localeCompare(b))) {
  const params = Object.entries(fn.parameters ?? {});
  const returnsStruct = (fn.return_pointer ?? 0) === 0 && isStruct(resolve(fn.return_type));
  const byValue = params.filter(([, p]) => (p.indirection ?? 0) === 0 && isStruct(resolve(p.type)));
  const returnFfi =
    returnsStruct || (fn.return_type === "opaque" && (fn.return_pointer ?? 0) === 0)
      ? "void"
      : ffiType(fn.return_type, fn.return_pointer ?? 0);

  const fn_ = `duckdb_${name}`;
  if (!returnsStruct && byValue.length === 0) {
    const args = params.map(([, p]) => JSON.stringify(ffiType(p.type, p.indirection ?? 0)));
    direct.push(`  duckdb_${name}: { args: [${args.join(", ")}], returns: ${JSON.stringify(returnFfi)} },`);
    guardDirect.push(guard(fn_, params.length));
    const cppParams = params.map((_, i) => `DBS_ARG(${fn_}, ${i}) a${i}`);
    const callArgs = params.map((_, i) => `a${i}`).join(", ");
    cppDirect.push(`dbs_cxx_${name}`);
    cpp.push(
      [
        `DBS_RET(${fn_}) dbs_cxx_${name}(${cppParams.join(", ")}) noexcept {`,
        `  try {`,
        `    return ${fn_}(${callArgs});`,
        `  } catch (...) {`,
        `    ::dbs::record_exception();`,
        `    return DBS_RET(${fn_})();`,
        `  }`,
        `}`,
      ].join("\n"),
    );
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

  guardWrapped.push(guard(`dbs_${name}`, args.length));
  // By-value struct parameters arrive as pointers to const, and a by-value struct
  // return is written through a trailing out pointer.
  const cppParams = params.map(([, p], i) =>
    (p.indirection ?? 0) === 0 && isStruct(resolve(p.type))
      ? `const DBS_ARG(${fn_}, ${i}) *a${i}`
      : `DBS_ARG(${fn_}, ${i}) a${i}`,
  );
  if (returnsStruct) cppParams.push(`DBS_RET(${fn_}) *out`);
  const callArgs = params
    .map(([, p], i) => ((p.indirection ?? 0) === 0 && isStruct(resolve(p.type)) ? `*a${i}` : `a${i}`))
    .join(", ");
  cppWrapped.push(`dbs_cxx_${name}`);
  cpp.push(
    [
      returnsStruct
        ? `void dbs_cxx_${name}(${cppParams.join(", ")}) noexcept {`
        : `DBS_RET(${fn_}) dbs_cxx_${name}(${cppParams.join(", ")}) noexcept {`,
      `  try {`,
      returnsStruct ? `    *out = ${fn_}(${callArgs});` : `    return ${fn_}(${callArgs});`,
      `  } catch (...) {`,
      `    ::dbs::record_exception();`,
      returnsStruct ? `    *out = DBS_RET(${fn_})();` : `    return DBS_RET(${fn_})();`,
      `  }`,
      `}`,
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
    'import type { ConvertFns, FFIFunction } from "bun:ffi";',
    "",
    "/**",
    " * Every libduckdb C function bun:ffi can call directly. The shim calls each through a",
    " * C++ wrapper that catches a C++ exception (native/cpp/boundary.hpp); the first",
    " * entries of its address table (native/ABI.md) are these, in this order.",
    " */",
    "export const capi = {",
    ...direct,
    "} as const;",
    "",
    "/**",
    " * The shim's wrappers for C functions that take or return a struct by value",
    " * (native/ABI.md), after the `capi` entries in the address table, in this order.",
    " */",
    "export const byValue = {",
    ...wrapped,
    "} as const;",
    "",
    "/** The functions bun:ffi makes of `T`, as plain functions. */",
    "type Plain<T extends Record<string, FFIFunction>> = {",
    "  [K in keyof T]: (...args: Parameters<ConvertFns<T>[K]>) => ReturnType<ConvertFns<T>[K]>;",
    "};",
    "type Capi = Plain<typeof capi>;",
    "type ByValue = Plain<typeof byValue>;",
    "",
    "/**",
    " * Wraps each function so it throws, through `raise`, when the call set the calling",
    " * thread's C++ exception flag, which `failed` views.",
    " */",
    "export function guardCapi(raw: ConvertFns<typeof capi>, failed: Int32Array, raise: () => never): Capi {",
    "  return {",
    ...guardDirect,
    "  };",
    "}",
    "",
    "/** As guardCapi, for the by-value wrappers. */",
    "export function guardByValue(raw: ConvertFns<typeof byValue>, failed: Int32Array, raise: () => never): ByValue {",
    "  return {",
    ...guardWrapped,
    "  };",
    "}",
    "",
    "/** The C layout of each spec struct on the shipped LP64 targets. */",
    "export const layouts = {",
    ...layoutLines,
    "} as const;",
    "",
  ].join("\n"),
);
const table = [...cppDirect, ...cppWrapped];
await Bun.write(
  CPP_OUT,
  [
    `// ${header}`,
    "// One wrapper per libduckdb C function JavaScript calls, each catching a C++",
    "// exception (boundary.hpp), and the table of their addresses that",
    "// dbs_capi_table() hands to the binding (native/ABI.md).",
    "",
    '#include "boundary.hpp"',
    "",
    // The deprecated functions stay callable, as the contract keeps them.
    '#pragma GCC diagnostic ignored "-Wdeprecated-declarations"',
    "",
    'extern "C" {',
    "",
    cpp.join("\n\n"),
    "",
    "/** The wrappers' addresses: those of src/bindings/generated/capi.ts `capi`, then `byValue`, in order. */",
    "const void *const *dbs_cxx_capi_table(std::size_t *count) noexcept {",
    "  static const void *const table[] = {",
    ...table.map((n) => `      reinterpret_cast<const void *>(&${n}),`),
    "  };",
    `  *count = ${table.length};`,
    "  return table;",
    "}",
    "",
    '}  // extern "C"',
    "",
  ].join("\n"),
);
await Bun.$`${join(ROOT, "node_modules", ".bin", "biome")} check --write ${TS_OUT}`.quiet();
console.log(`capi: ${direct.length} direct, ${wrapped.length} by value, ${layouts.size} struct layouts`);
