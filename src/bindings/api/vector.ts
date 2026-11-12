// Vector, validity mask and raw data functions of the @duckdb/node-bindings
// contract. Semantics and error text follow the official binding
// (bindings/src/duckdb_node_bindings.cpp and conversion_helpers.h at the
// fork tag).
//
// vector_get_data, vector_get_validity and get_data_from_pointer return Buffers
// over DuckDB's memory, as the official external buffers do, of the byte count
// the caller asks for: DuckDB exposes no capacity to check it against. Each view
// keeps the handle that owns its memory reachable (runtime/scope.ts).
import { type Pointer, toArrayBuffer } from "bun:ffi";
import type { LogicalType, Value, Vector } from "../generated/contract.ts";
import {
  checkValidityRowInRange,
  expectBoolean,
  expectString,
  throwIndexOutOfRange,
  uint32FromNumber,
} from "../runtime/convert.ts";
import { type Handle, handleOf, unwrap } from "../runtime/handle.ts";
import { borrow, own } from "../runtime/kinds.ts";
import { slot, utf8 } from "../runtime/marshal.ts";
import { duckdb } from "../runtime/native.ts";
import { derived, liveOwnerOfBuffer, nativeCopy } from "../runtime/scope.ts";

function asHandle<T>(handle: Handle): T {
  return handle as unknown as T;
}

/** node-addon-api's Uint8Array cast: any typed array, read as bytes. */
function bytesOf(value: unknown): Uint8Array {
  if (!ArrayBuffer.isView(value) || value instanceof DataView) throw new Error("Invalid argument");
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/** node-addon-api's ArrayBuffer cast. */
function arrayBufferOf(value: unknown): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) throw new Error("Invalid argument");
  return value;
}

/** A vector a parent vector owns, such as a list's child, kept alive through the parent. */
function childVector(parent: Handle, child: Pointer | null): Vector {
  return asHandle(derived(parent, borrow("vector", child, parent)));
}

// --- vectors -------------------------------------------------------------------------------

export function vector_size(): number {
  return Number(duckdb.duckdb_vector_size());
}

export function create_vector(logical_type: LogicalType, capacity: number): Vector {
  const type = unwrap(logical_type, "logical type");
  const vector = duckdb.duckdb_create_vector(type, uint32FromNumber(capacity)) as Pointer | null;
  if (vector === null) throw new Error("Failed to create vector");
  return asHandle(own("vector", vector));
}

export function vector_get_column_type(vector: Vector): LogicalType {
  const type = duckdb.duckdb_vector_get_column_type(unwrap(vector, "vector")) as Pointer;
  return asHandle(own("logical type", type));
}

export function vector_get_data(vector: Vector, byte_count: number): Uint8Array {
  const handle = handleOf(vector, "vector");
  const byteCount = uint32FromNumber(byte_count);
  const data = duckdb.duckdb_vector_get_data(handle.ptr) as Pointer | null;
  return nativeCopy(data, byteCount, handle);
}

export function vector_get_validity(vector: Vector, byte_count: number): Uint8Array {
  const handle = handleOf(vector, "vector");
  const byteCount = uint32FromNumber(byte_count);
  const validity = duckdb.duckdb_vector_get_validity(handle.ptr) as Pointer | null;
  // The contract types this as Uint8Array, but the official binding returns
  // null for a vector without a validity mask, and callers rely on it.
  if (validity === null) return null as unknown as Uint8Array;
  return nativeCopy(validity, byteCount, handle);
}

export function vector_ensure_validity_writable(vector: Vector): void {
  duckdb.duckdb_vector_ensure_validity_writable(unwrap(vector, "vector"));
}

// Not bounds-checked, as in the official binding: the C API exposes no capacity
// for a vector (a list child grows past duckdb_vector_size()), so the caller
// bounds the index.
export function vector_assign_string_element(vector: Vector, index: number, str: string): void {
  const ptr = unwrap(vector, "vector");
  const row = uint32FromNumber(index);
  // The _len variant keeps embedded NUL characters.
  const { bytes, length } = utf8(expectString(str));
  duckdb.duckdb_vector_assign_string_element_len(ptr, row, bytes, length);
}

export function vector_assign_string_element_len(vector: Vector, index: number, data: Uint8Array): void {
  const ptr = unwrap(vector, "vector");
  const row = uint32FromNumber(index);
  const bytes = bytesOf(data);
  // A zero-length view still needs a valid address; DuckDB reads none of it.
  duckdb.duckdb_vector_assign_string_element_len(
    ptr,
    row,
    bytes.byteLength === 0 ? new Uint8Array(1) : bytes,
    bytes.byteLength,
  );
}

export function list_vector_get_child(vector: Vector): Vector {
  const handle = handleOf(vector, "vector");
  return childVector(handle, duckdb.duckdb_list_vector_get_child(handle.ptr) as Pointer | null);
}

export function list_vector_get_size(vector: Vector): number {
  return Number(duckdb.duckdb_list_vector_get_size(unwrap(vector, "vector")));
}

export function list_vector_set_size(vector: Vector, size: number): void {
  const ptr = unwrap(vector, "vector");
  duckdb.duckdb_list_vector_set_size(ptr, uint32FromNumber(size));
}

export function list_vector_reserve(vector: Vector, required_capacity: number): void {
  const ptr = unwrap(vector, "vector");
  duckdb.duckdb_list_vector_reserve(ptr, uint32FromNumber(required_capacity));
}

/**
 * Bounds-checked, unlike the official binding. Out of range, DuckDB throws a C++
 * exception across the C API, which node-addon-api happens to catch but which
 * aborts the process through bun:ffi, so the index is checked against the
 * vector's struct child count first (a union counts its tag).
 */
export function struct_vector_get_child(vector: Vector, index: number): Vector {
  const handle = handleOf(vector, "vector");
  const ptr = handle.ptr;
  const childIndex = uint32FromNumber(index);
  if (ptr !== null) {
    const type = duckdb.duckdb_vector_get_column_type(ptr) as Pointer;
    const count = Number(duckdb.duckdb_struct_type_child_count(type));
    duckdb.duckdb_destroy_logical_type(slot(type));
    if (childIndex >= count) throwIndexOutOfRange(childIndex, count, "struct entry");
  }
  return childVector(handle, duckdb.duckdb_struct_vector_get_child(ptr, childIndex) as Pointer | null);
}

export function array_vector_get_child(vector: Vector): Vector {
  const handle = handleOf(vector, "vector");
  return childVector(handle, duckdb.duckdb_array_vector_get_child(handle.ptr) as Pointer | null);
}

export function vector_reference_value(vector: Vector, value: Value): void {
  const ptr = unwrap(vector, "vector");
  duckdb.duckdb_vector_reference_value(ptr, unwrap(value, "value"));
}

// --- validity masks ---------------------------------------------------------------------------
//
// The duckdb_validity_* functions index a mask of uint64 words, where row r is
// bit r % 64 of word r / 64. On the little-endian platforms this package ships
// for, that is bit r % 8 of byte r / 8, so these read and write the Uint8Array
// directly instead of crossing into C, after the same bounds check.

function rowBit(mask: Uint8Array, row: number): { byte: number; bit: number } {
  checkValidityRowInRange(mask, row);
  return { byte: row >>> 3, bit: 1 << (row & 7) };
}

export function validity_row_is_valid(validity: Uint8Array | null, row_index: number): boolean {
  const row = uint32FromNumber(row_index);
  // A null mask means every row is valid, so there is nothing to bound.
  if (validity === null) return true;
  const mask = bytesOf(validity);
  const { byte, bit } = rowBit(mask, row);
  return (mask[byte] & bit) !== 0;
}

function setRow(mask: Uint8Array, row: number, valid: boolean): void {
  const { byte, bit } = rowBit(mask, row);
  mask[byte] = valid ? mask[byte] | bit : mask[byte] & ~bit;
}

export function validity_set_row_validity(validity: Uint8Array, row_index: number, valid: boolean): void {
  const mask = bytesOf(validity);
  const row = uint32FromNumber(row_index);
  setRow(mask, row, expectBoolean(valid));
}

export function validity_set_row_invalid(validity: Uint8Array, row_index: number): void {
  const mask = bytesOf(validity);
  setRow(mask, uint32FromNumber(row_index), false);
}

export function validity_set_row_valid(validity: Uint8Array, row_index: number): void {
  const mask = bytesOf(validity);
  setRow(mask, uint32FromNumber(row_index), true);
}

// --- raw data ---------------------------------------------------------------------------------

/**
 * The `byte_count` bytes a pointer stored at `pointer_offset` of `array_buffer`
 * points to: the out-of-line bytes of a duckdb_string_t in a copy of a vector's
 * data, copied as the official binding does. It throws when that vector is gone,
 * since the string lives in the vector's string heap.
 */
export function get_data_from_pointer(
  array_buffer: ArrayBuffer,
  pointer_offset: number,
  byte_count: number,
): Uint8Array {
  const buffer = arrayBufferOf(array_buffer);
  const offset = uint32FromNumber(pointer_offset);
  const byteCount = uint32FromNumber(byte_count);
  const owner = liveOwnerOfBuffer(buffer);
  const pointer = Number(new DataView(buffer).getBigUint64(offset, true));
  return nativeCopy(pointer, byteCount, owner);
}

function copyInto(
  target: Pointer | null,
  targetOffset: number,
  source: ArrayBuffer,
  sourceOffset: number,
  byteCount: number,
  what: string,
): void {
  const bytes = new Uint8Array(source, sourceOffset, byteCount);
  if (byteCount === 0) return;
  // The official binding copies to whatever pointer DuckDB returns, and so
  // writes through null for a vector with no data or no validity mask.
  if (target === null) throw new Error(`Vector has no ${what}`);
  new Uint8Array(toArrayBuffer(target, targetOffset, byteCount)).set(bytes);
}

export function copy_data_to_vector(
  target_vector: Vector,
  target_byte_offset: number,
  source_buffer: ArrayBuffer,
  source_byte_offset: number,
  source_byte_count: number,
): void {
  const ptr = unwrap(target_vector, "vector");
  const targetOffset = uint32FromNumber(target_byte_offset);
  const source = arrayBufferOf(source_buffer);
  const sourceOffset = uint32FromNumber(source_byte_offset);
  const byteCount = uint32FromNumber(source_byte_count);
  const target = duckdb.duckdb_vector_get_data(ptr) as Pointer | null;
  copyInto(target, targetOffset, source, sourceOffset, byteCount, "data");
}

export function copy_data_to_vector_validity(
  target_vector: Vector,
  target_byte_offset: number,
  source_buffer: ArrayBuffer,
  source_byte_offset: number,
  source_byte_count: number,
): void {
  const ptr = unwrap(target_vector, "vector");
  const targetOffset = uint32FromNumber(target_byte_offset);
  const source = arrayBufferOf(source_buffer);
  const sourceOffset = uint32FromNumber(source_byte_offset);
  const byteCount = uint32FromNumber(source_byte_count);
  const target = duckdb.duckdb_vector_get_validity(ptr) as Pointer | null;
  copyInto(target, targetOffset, source, sourceOffset, byteCount, "validity mask");
}
