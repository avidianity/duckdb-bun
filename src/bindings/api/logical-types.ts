// Logical type functions of the @duckdb/node-bindings contract. Semantics, error
// text and index checks follow the official binding
// (bindings/src/duckdb_node_bindings.cpp at the vendored tag).
import { type Pointer, ptr } from "bun:ffi";
import { type LogicalType, Type } from "../generated/contract.ts";
import { checkIndexInRange, expectArray, expectString, uint32FromNumber } from "../runtime/convert.ts";
import type { Handle } from "../runtime/handle.ts";
import { unwrap } from "../runtime/handle.ts";
import { own } from "../runtime/kinds.ts";
import { cstr, takeCString } from "../runtime/marshal.ts";
import { duckdb } from "../runtime/native.ts";

function asLogicalType(handle: Handle): LogicalType {
  return handle as unknown as LogicalType;
}

/** Wraps a logical type the caller owns; a null pointer stays null, as the official external does. */
function ownLogicalType(pointer: Pointer | null): LogicalType {
  return asLogicalType(own("logical type", pointer as Pointer));
}

function logicalTypePointer(logical_type: unknown): Pointer | null {
  return unwrap(logical_type, "logical type");
}

/**
 * A C string DuckDB allocated, freed after reading. A null pointer throws what
 * Napi::String::New throws for one.
 */
function takeString(pointer: Pointer | null): string {
  const text = takeCString(pointer);
  if (text === null) throw new Error("Invalid argument");
  return text;
}

/**
 * A `const char **` array of `names` in one buffer: a pointer slot per name (at
 * least one, as the official binding allocates) followed by the NUL-terminated
 * UTF-8 names it points to. Passing the buffer to the C call keeps the names
 * alive for exactly as long as it runs.
 */
function cStringArray(names: readonly string[]): Uint8Array {
  const strings = names.map((name) => cstr(name));
  const slots = Math.max(names.length, 1) * 8;
  const buffer = new Uint8Array(slots + strings.reduce((total, bytes) => total + bytes.byteLength, 0));
  const pointers = new BigUint64Array(buffer.buffer, 0, slots / 8);
  const base = ptr(buffer);
  let offset = slots;
  strings.forEach((bytes, i) => {
    buffer.set(bytes, offset);
    pointers[i] = BigInt(base + offset);
    offset += bytes.byteLength;
  });
  return buffer;
}

/** The member types and names of create_struct_type and create_union_type, read in the official order. */
function members(
  member_types: unknown,
  member_names: unknown,
): { types: BigUint64Array; names: Uint8Array; count: number } {
  const typesArray = expectArray(member_types);
  const namesArray = expectArray(member_names);
  const count = Math.min(typesArray.length, namesArray.length);
  const types = new BigUint64Array(Math.max(count, 1));
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    types[i] = BigInt(logicalTypePointer(typesArray[i]) ?? 0);
    names.push(expectString(namesArray[i]));
  }
  return { types, names: cStringArray(names), count };
}

// --- creation -----------------------------------------------------------------------

export function create_logical_type(type: Type): LogicalType {
  const id = uint32FromNumber(type);
  // duckdb_create_logical_type returns a VARIANT without its child types, and
  // using it crashes; see https://github.com/duckdb/duckdb/issues/24680.
  if (id === Type.VARIANT) {
    throw new Error("Cannot create a VARIANT logical type; see https://github.com/duckdb/duckdb/issues/24680");
  }
  return ownLogicalType(duckdb.duckdb_create_logical_type(id | 0) as Pointer | null);
}

export function logical_type_get_alias(logical_type: LogicalType): string | null {
  return takeCString(duckdb.duckdb_logical_type_get_alias(logicalTypePointer(logical_type)) as Pointer | null);
}

export function logical_type_set_alias(logical_type: LogicalType, alias: string): void {
  const pointer = logicalTypePointer(logical_type);
  duckdb.duckdb_logical_type_set_alias(pointer, cstr(expectString(alias)));
}

export function create_list_type(logical_type: LogicalType): LogicalType {
  return ownLogicalType(duckdb.duckdb_create_list_type(logicalTypePointer(logical_type)) as Pointer | null);
}

export function create_array_type(logical_type: LogicalType, array_size: number): LogicalType {
  const child = logicalTypePointer(logical_type);
  const size = uint32FromNumber(array_size);
  return ownLogicalType(duckdb.duckdb_create_array_type(child, size) as Pointer | null);
}

export function create_map_type(key_type: LogicalType, value_type: LogicalType): LogicalType {
  const key = logicalTypePointer(key_type);
  const value = logicalTypePointer(value_type);
  return ownLogicalType(duckdb.duckdb_create_map_type(key, value) as Pointer | null);
}

export function create_union_type(member_types: readonly LogicalType[], member_names: readonly string[]): LogicalType {
  const { types, names, count } = members(member_types, member_names);
  return ownLogicalType(duckdb.duckdb_create_union_type(types, names, count) as Pointer | null);
}

export function create_struct_type(member_types: readonly LogicalType[], member_names: readonly string[]): LogicalType {
  const { types, names, count } = members(member_types, member_names);
  return ownLogicalType(duckdb.duckdb_create_struct_type(types, names, count) as Pointer | null);
}

export function create_enum_type(member_names: readonly string[]): LogicalType {
  const namesArray = expectArray(member_names);
  const names = namesArray.map((name) => expectString(name));
  return ownLogicalType(duckdb.duckdb_create_enum_type(cStringArray(names), names.length) as Pointer | null);
}

/** width and scale go through Number::Uint32Value and then narrow to uint8_t, as in the official binding. */
export function create_decimal_type(width: number, scale: number): LogicalType {
  const width8 = uint32FromNumber(width) & 0xff;
  const scale8 = uint32FromNumber(scale) & 0xff;
  return ownLogicalType(duckdb.duckdb_create_decimal_type(width8, scale8) as Pointer | null);
}

// --- accessors ----------------------------------------------------------------------

export function get_type_id(logical_type: LogicalType): Type {
  return duckdb.duckdb_get_type_id(logicalTypePointer(logical_type)) as Type;
}

export function decimal_width(logical_type: LogicalType): number {
  return duckdb.duckdb_decimal_width(logicalTypePointer(logical_type));
}

export function decimal_scale(logical_type: LogicalType): number {
  return duckdb.duckdb_decimal_scale(logicalTypePointer(logical_type));
}

export function decimal_internal_type(logical_type: LogicalType): Type {
  return duckdb.duckdb_decimal_internal_type(logicalTypePointer(logical_type)) as Type;
}

export function enum_internal_type(logical_type: LogicalType): Type {
  return duckdb.duckdb_enum_internal_type(logicalTypePointer(logical_type)) as Type;
}

export function enum_dictionary_size(logical_type: LogicalType): number {
  return duckdb.duckdb_enum_dictionary_size(logicalTypePointer(logical_type));
}

/** duckdb_enum_dictionary_value reads out of bounds for a bad index, so it is checked first. */
export function enum_dictionary_value(logical_type: LogicalType, index: number): string {
  const pointer = logicalTypePointer(logical_type);
  const position = uint32FromNumber(index);
  checkIndexInRange(position, duckdb.duckdb_enum_dictionary_size(pointer), "enum value");
  return takeString(duckdb.duckdb_enum_dictionary_value(pointer, position) as Pointer | null);
}

export function list_type_child_type(logical_type: LogicalType): LogicalType {
  return ownLogicalType(duckdb.duckdb_list_type_child_type(logicalTypePointer(logical_type)) as Pointer | null);
}

export function array_type_child_type(logical_type: LogicalType): LogicalType {
  return ownLogicalType(duckdb.duckdb_array_type_child_type(logicalTypePointer(logical_type)) as Pointer | null);
}

export function array_type_array_size(logical_type: LogicalType): number {
  return Number(duckdb.duckdb_array_type_array_size(logicalTypePointer(logical_type)));
}

export function map_type_key_type(logical_type: LogicalType): LogicalType {
  return ownLogicalType(duckdb.duckdb_map_type_key_type(logicalTypePointer(logical_type)) as Pointer | null);
}

export function map_type_value_type(logical_type: LogicalType): LogicalType {
  return ownLogicalType(duckdb.duckdb_map_type_value_type(logicalTypePointer(logical_type)) as Pointer | null);
}

export function struct_type_child_count(logical_type: LogicalType): number {
  return Number(duckdb.duckdb_struct_type_child_count(logicalTypePointer(logical_type)));
}

/** The struct accessors throw a C++ exception across the C boundary for a bad index, so it is checked first. */
export function struct_type_child_name(logical_type: LogicalType, index: number): string {
  const pointer = logicalTypePointer(logical_type);
  const position = uint32FromNumber(index);
  checkIndexInRange(position, Number(duckdb.duckdb_struct_type_child_count(pointer)), "struct entry");
  return takeString(duckdb.duckdb_struct_type_child_name(pointer, position) as Pointer | null);
}

export function struct_type_child_type(logical_type: LogicalType, index: number): LogicalType {
  const pointer = logicalTypePointer(logical_type);
  const position = uint32FromNumber(index);
  checkIndexInRange(position, Number(duckdb.duckdb_struct_type_child_count(pointer)), "struct entry");
  return ownLogicalType(duckdb.duckdb_struct_type_child_type(pointer, position) as Pointer | null);
}

export function union_type_member_count(logical_type: LogicalType): number {
  return Number(duckdb.duckdb_union_type_member_count(logicalTypePointer(logical_type)));
}

export function union_type_member_name(logical_type: LogicalType, index: number): string {
  const pointer = logicalTypePointer(logical_type);
  const position = uint32FromNumber(index);
  checkIndexInRange(position, Number(duckdb.duckdb_union_type_member_count(pointer)), "union member");
  return takeString(duckdb.duckdb_union_type_member_name(pointer, position) as Pointer | null);
}

export function union_type_member_type(logical_type: LogicalType, index: number): LogicalType {
  const pointer = logicalTypePointer(logical_type);
  const position = uint32FromNumber(index);
  checkIndexInRange(position, Number(duckdb.duckdb_union_type_member_count(pointer)), "union member");
  return ownLogicalType(duckdb.duckdb_union_type_member_type(pointer, position) as Pointer | null);
}

export function geometry_type_get_crs(logical_type: LogicalType): string | null {
  return takeCString(duckdb.duckdb_geometry_type_get_crs(logicalTypePointer(logical_type)) as Pointer | null);
}
