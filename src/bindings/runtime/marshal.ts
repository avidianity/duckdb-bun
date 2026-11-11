// Moving values across bun:ffi: strings, out slots, and the C structs the
// contract exposes as plain objects (Date_, Interval, Decimal, ...), encoded and
// decoded from the layouts generated from DuckDB's C API spec.
import { CString, type Pointer, read, toArrayBuffer } from "bun:ffi";
import { layouts } from "../generated/capi.ts";
import { duckdb } from "./native.ts";

type LayoutName = keyof typeof layouts;
type FieldType = string;

const encoder = new TextEncoder();

/** A NUL-terminated UTF-8 copy of `text`, for a C `const char *` argument. */
export function cstr(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf8");
}

/** UTF-8 bytes of `text` and their length, for a shim `(*const u8, usize)` argument. */
export function utf8(text: string): { bytes: Uint8Array; length: number } {
  const bytes = encoder.encode(text);
  // bun:ffi rejects a pointer to an empty view, and the shim copies `length`
  // bytes, so one padding byte is safe and keeps the pointer valid.
  return { bytes: bytes.length === 0 ? new Uint8Array(1) : bytes, length: bytes.length };
}

/** Reads a NUL-terminated C string DuckDB owns. */
export function readCString(pointer: Pointer | null): string | null {
  return pointer === null ? null : new CString(pointer).toString();
}

/** Reads a C string DuckDB allocated for the caller, then frees it with duckdb_free. */
export function takeCString(pointer: Pointer | null): string | null {
  if (pointer === null) return null;
  try {
    return new CString(pointer).toString();
  } finally {
    duckdb.duckdb_free(pointer);
  }
}

/** A pointer-sized out slot, such as the `duckdb_database *out` of duckdb_open. */
export function slot(value: Pointer | null = null): BigUint64Array {
  return new BigUint64Array([BigInt(value ?? 0)]);
}

export function slotValue(cell: BigUint64Array): Pointer | null {
  const value = Number(cell[0]);
  return value === 0 ? null : (value as Pointer);
}

/** A copy of `length` bytes at `pointer`, or an empty array for a null pointer. */
export function copyBytes(pointer: Pointer | null, length: number): Uint8Array {
  if (pointer === null || length === 0) return new Uint8Array(0);
  return new Uint8Array(toArrayBuffer(pointer, 0, length).slice(0));
}

// --- structs ----------------------------------------------------------------------

const BIGINT_FIELDS = new Set<FieldType>(["i64", "u64", "idx"]);
const WIDE_INTEGERS = new Set<string>(["hugeint", "uhugeint"]);

function readField(view: DataView, offset: number, type: FieldType): unknown {
  switch (type) {
    case "bool":
      return view.getUint8(offset) !== 0;
    case "i8":
      return view.getInt8(offset);
    case "u8":
      return view.getUint8(offset);
    case "i16":
      return view.getInt16(offset, true);
    case "u16":
      return view.getUint16(offset, true);
    case "i32":
    case "TYPE":
      return view.getInt32(offset, true);
    case "u32":
      return view.getUint32(offset, true);
    case "i64":
      return view.getBigInt64(offset, true);
    case "u64":
    case "idx":
      return view.getBigUint64(offset, true);
    case "f32":
      return view.getFloat32(offset, true);
    case "f64":
      return view.getFloat64(offset, true);
    case "ptr":
      return Number(view.getBigUint64(offset, true));
    default:
      return decodeAt(type as LayoutName, view, offset);
  }
}

function writeField(view: DataView, offset: number, type: FieldType, value: unknown): void {
  switch (type) {
    case "bool":
      view.setUint8(offset, value ? 1 : 0);
      return;
    case "i8":
      view.setInt8(offset, Number(value));
      return;
    case "u8":
      view.setUint8(offset, Number(value));
      return;
    case "i16":
      view.setInt16(offset, Number(value), true);
      return;
    case "u16":
      view.setUint16(offset, Number(value), true);
      return;
    case "i32":
    case "TYPE":
      view.setInt32(offset, Number(value), true);
      return;
    case "u32":
      view.setUint32(offset, Number(value), true);
      return;
    case "i64":
      view.setBigInt64(offset, BigInt(value as bigint), true);
      return;
    case "u64":
    case "idx":
      view.setBigUint64(offset, BigInt(value as bigint), true);
      return;
    case "f32":
      view.setFloat32(offset, Number(value), true);
      return;
    case "f64":
      view.setFloat64(offset, Number(value), true);
      return;
    case "ptr":
      view.setBigUint64(offset, BigInt(Number(value)), true);
      return;
    default:
      encodeAt(type as LayoutName, view, offset, value);
  }
}

function decodeAt(name: LayoutName, view: DataView, offset: number): unknown {
  if (WIDE_INTEGERS.has(name)) {
    const lower = view.getBigUint64(offset, true);
    const upper = name === "hugeint" ? view.getBigInt64(offset + 8, true) : view.getBigUint64(offset + 8, true);
    return (upper << 64n) | lower;
  }
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(layouts[name].fields)) {
    out[field] = readField(view, offset + spec.offset, spec.type);
  }
  return out;
}

function encodeAt(name: LayoutName, view: DataView, offset: number, value: unknown): void {
  if (WIDE_INTEGERS.has(name)) {
    const wide = BigInt(value as bigint);
    view.setBigUint64(offset, BigInt.asUintN(64, wide), true);
    if (name === "hugeint") view.setBigInt64(offset + 8, BigInt.asIntN(64, wide >> 64n), true);
    else view.setBigUint64(offset + 8, BigInt.asUintN(64, wide >> 64n), true);
    return;
  }
  const fields = value as Record<string, unknown>;
  for (const [field, spec] of Object.entries(layouts[name].fields)) {
    writeField(view, offset + spec.offset, spec.type, fields[field]);
  }
}

/** A zeroed buffer of the struct's C size, for an out parameter. */
export function structBuffer(name: LayoutName): Uint8Array {
  return new Uint8Array(layouts[name].size);
}

/** Encodes a contract object (or a bigint for hugeint/uhugeint) into the struct's C layout. */
export function encode(name: LayoutName, value: unknown): Uint8Array {
  const buffer = structBuffer(name);
  encodeAt(name, new DataView(buffer.buffer), 0, value);
  return buffer;
}

/** Decodes a struct from a buffer or from native memory into a contract object. */
export function decode<T>(name: LayoutName, source: Uint8Array | Pointer): T {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(toArrayBuffer(source, 0, layouts[name].size));
  return decodeAt(name, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0) as T;
}

/** True when the field type reads as a bigint, for callers that convert to number. */
export function isBigIntField(type: FieldType): boolean {
  return BIGINT_FIELDS.has(type);
}

export { read };
