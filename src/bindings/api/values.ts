// Value functions of the @duckdb/node-bindings contract: duckdb_create_*,
// duckdb_get_* and the nested value accessors. Semantics, error text and memory
// ownership follow the official binding (bindings/src/duckdb_node_bindings.cpp
// at the vendored tag) and the C API docs in vendor/duckdb.h.
import { type Pointer, ptr } from "bun:ffi";
import type {
  Date_,
  Decimal,
  Interval,
  LogicalType,
  Time,
  TimeNS,
  Timestamp,
  TimestampMilliseconds,
  TimestampNanoseconds,
  TimestampSeconds,
  TimeTZ,
  Value,
} from "../generated/contract.ts";
import {
  bigIntFromBignum,
  bignumFromBigInt,
  dateFromObject,
  decimalFromObject,
  expectArray,
  expectBoolean,
  expectNumber,
  expectString,
  hugeintFromBigInt,
  int64FromBigInt,
  integerFromNumber,
  intervalFromObject,
  timeFromObject,
  timeNsFromObject,
  timestampFromObject,
  timestampMillisecondsFromObject,
  timestampNanosecondsFromObject,
  timestampSecondsFromObject,
  timeTzFromObject,
  uhugeintFromBigInt,
  uint32FromNumber,
  uint64FromBigInt,
} from "../runtime/convert.ts";
import { type Handle, handleOf, unwrap } from "../runtime/handle.ts";
import { borrow, own } from "../runtime/kinds.ts";
import { copyBytes, decode, encode, type LayoutName, structBuffer, takeCString, utf8 } from "../runtime/marshal.ts";
import { duckdb, shim } from "../runtime/native.ts";

function asValue(handle: Handle): Value {
  return handle as unknown as Value;
}

/** Wraps a value the caller owns; DuckDB's create and get functions return new values. */
function ownValue(pointer: Pointer | null): Value {
  return asValue(own("value", pointer as Pointer));
}

function valuePointer(value: unknown): Pointer | null {
  return unwrap(value, "value");
}

/**
 * The pointer of a value a scalar getter may read. get_table_names gives a value
 * without a pointer for SQL that does not parse, which libduckdb's scalar
 * getters dereference; the official binding dies with SIGSEGV there, and ours
 * refuses it instead.
 */
function presentValuePointer(value: unknown): Pointer {
  const pointer = valuePointer(value);
  if (pointer === null) throw new Error("Invalid value argument");
  return pointer;
}

function logicalTypePointer(logical_type: unknown): Pointer | null {
  return unwrap(logical_type, "logical type");
}

/** Wraps a new value, or throws `message` when DuckDB returned null. */
function ownValueOrThrow(pointer: Pointer | null, message: string): Value {
  if (pointer === null) throw new Error(message);
  return ownValue(pointer);
}

/** Calls a shim `dbs_get_<x>(value, out)` wrapper and decodes the struct it wrote. */
function getStruct<T>(
  layout: LayoutName,
  call: (value: Pointer | null, out: Uint8Array) => void,
  value: Value,
  pointerOf: (value: unknown) => Pointer | null = presentValuePointer,
): T {
  const pointer = pointerOf(value);
  const out = structBuffer(layout);
  call(pointer, out);
  return decode<T>(layout, out);
}

/**
 * The bytes of a TypedArray, as node-addon-api's Uint8Array cast reads them:
 * any TypedArray is accepted by its byte length, and anything else fails in
 * napi_get_typedarray_info with N-API's "Invalid argument".
 */
function typedArrayBytes(data: unknown): Uint8Array {
  if (!ArrayBuffer.isView(data) || data instanceof DataView) throw new Error("Invalid argument");
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** `bytes`, or one padding byte for an empty view, whose address bun:ffi cannot take. */
function nonEmpty(bytes: Uint8Array): Uint8Array {
  return bytes.byteLength === 0 ? new Uint8Array(1) : bytes;
}

/**
 * A duckdb_bit or duckdb_bignum struct followed by a copy of its data in one
 * buffer, with the struct's data field pointing just past the struct. Passing
 * the buffer to the C call keeps the data alive for exactly as long as it runs.
 */
function structWithData(layout: "bit" | "bignum", fields: Record<string, unknown>, bytes: Uint8Array): Uint8Array {
  const size = structBuffer(layout).byteLength;
  const buffer = new Uint8Array(size + Math.max(bytes.byteLength, 1));
  buffer.set(bytes, size);
  buffer.set(encode(layout, { ...fields, data: ptr(buffer, size), size: BigInt(bytes.byteLength) }));
  return buffer;
}

/** A pointer array of `count` slots (at least one, as the official binding allocates) holding `values`. */
function valuePointers(values: readonly unknown[], count: number): BigUint64Array {
  const pointers = new BigUint64Array(Math.max(count, 1));
  values.forEach((value, i) => {
    pointers[i] = BigInt(valuePointer(value) ?? 0);
  });
  return pointers;
}

/**
 * Copies a blob, bit or bignum `data` field DuckDB allocated with malloc, then
 * frees it with duckdb_free, as vendor/duckdb.h asks for get_bit and
 * get_bignum and DuckDB's source does for get_blob.
 */
function takeData(data: number, size: bigint): Uint8Array {
  const pointer = data === 0 ? null : (data as Pointer);
  try {
    return copyBytes(pointer, Number(size));
  } finally {
    if (pointer !== null) duckdb.duckdb_free(pointer);
  }
}

/** A Buffer over `bytes`, the type the official binding's Napi::Buffer returns. */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// --- create -------------------------------------------------------------------------

export function create_varchar(text: string): Value {
  const { bytes, length } = utf8(expectString(text));
  return ownValue(duckdb.duckdb_create_varchar_length(bytes, length) as Pointer | null);
}

export function create_bool(input: boolean): Value {
  return ownValue(duckdb.duckdb_create_bool(expectBoolean(input)) as Pointer | null);
}

export function create_int8(input: number): Value {
  return ownValue(duckdb.duckdb_create_int8(integerFromNumber(input, "int8")) as Pointer | null);
}

export function create_uint8(input: number): Value {
  return ownValue(duckdb.duckdb_create_uint8(integerFromNumber(input, "uint8")) as Pointer | null);
}

export function create_int16(input: number): Value {
  return ownValue(duckdb.duckdb_create_int16(integerFromNumber(input, "int16")) as Pointer | null);
}

export function create_uint16(input: number): Value {
  return ownValue(duckdb.duckdb_create_uint16(integerFromNumber(input, "uint16")) as Pointer | null);
}

export function create_int32(input: number): Value {
  return ownValue(duckdb.duckdb_create_int32(integerFromNumber(input, "int32")) as Pointer | null);
}

export function create_uint32(input: number): Value {
  return ownValue(duckdb.duckdb_create_uint32(integerFromNumber(input, "uint32")) as Pointer | null);
}

export function create_uint64(input: bigint): Value {
  return ownValue(duckdb.duckdb_create_uint64(uint64FromBigInt(input, "bigint")) as Pointer | null);
}

export function create_int64(input: bigint): Value {
  return ownValue(duckdb.duckdb_create_int64(int64FromBigInt(input, "bigint")) as Pointer | null);
}

export function create_hugeint(input: bigint): Value {
  return ownValue(shim.dbs_create_hugeint(encode("hugeint", hugeintFromBigInt(input))) as Pointer | null);
}

export function create_uhugeint(input: bigint): Value {
  return ownValue(shim.dbs_create_uhugeint(encode("uhugeint", uhugeintFromBigInt(input))) as Pointer | null);
}

export function create_bignum(input: bigint): Value {
  const { bytes, isNegative } = bignumFromBigInt(input);
  const bignum = structWithData("bignum", { is_negative: isNegative }, bytes);
  return ownValue(shim.dbs_create_bignum(bignum) as Pointer | null);
}

export function create_decimal(input: Decimal): Value {
  return ownValue(shim.dbs_create_decimal(encode("decimal", decimalFromObject(input))) as Pointer | null);
}

/** The double narrows to float as static_cast<float> does. */
export function create_float(input: number): Value {
  return ownValue(duckdb.duckdb_create_float(expectNumber(input)) as Pointer | null);
}

export function create_double(input: number): Value {
  return ownValue(duckdb.duckdb_create_double(expectNumber(input)) as Pointer | null);
}

export function create_date(input: Date_): Value {
  return ownValue(shim.dbs_create_date(encode("date", dateFromObject(input))) as Pointer | null);
}

export function create_time(input: Time): Value {
  return ownValue(shim.dbs_create_time(encode("time", timeFromObject(input))) as Pointer | null);
}

export function create_time_ns(input: TimeNS): Value {
  return ownValue(shim.dbs_create_time_ns(encode("time_ns", timeNsFromObject(input))) as Pointer | null);
}

export function create_time_tz_value(input: TimeTZ): Value {
  return ownValue(shim.dbs_create_time_tz_value(encode("time_tz", timeTzFromObject(input))) as Pointer | null);
}

export function create_timestamp(input: Timestamp): Value {
  return ownValue(shim.dbs_create_timestamp(encode("timestamp", timestampFromObject(input))) as Pointer | null);
}

export function create_timestamp_tz(input: Timestamp): Value {
  return ownValue(shim.dbs_create_timestamp_tz(encode("timestamp", timestampFromObject(input))) as Pointer | null);
}

export function create_timestamp_tz_ns(input: TimestampNanoseconds): Value {
  const timestamp = encode("timestamp_ns", timestampNanosecondsFromObject(input));
  return ownValue(shim.dbs_create_timestamp_tz_ns(timestamp) as Pointer | null);
}

export function create_timestamp_s(input: TimestampSeconds): Value {
  const timestamp = encode("timestamp_s", timestampSecondsFromObject(input));
  return ownValue(shim.dbs_create_timestamp_s(timestamp) as Pointer | null);
}

export function create_timestamp_ms(input: TimestampMilliseconds): Value {
  const timestamp = encode("timestamp_ms", timestampMillisecondsFromObject(input));
  return ownValue(shim.dbs_create_timestamp_ms(timestamp) as Pointer | null);
}

export function create_timestamp_ns(input: TimestampNanoseconds): Value {
  const timestamp = encode("timestamp_ns", timestampNanosecondsFromObject(input));
  return ownValue(shim.dbs_create_timestamp_ns(timestamp) as Pointer | null);
}

export function create_interval(input: Interval): Value {
  return ownValue(shim.dbs_create_interval(encode("interval", intervalFromObject(input))) as Pointer | null);
}

/** DuckDB copies the bytes, so the array needs to live only for the call. */
export function create_blob(data: Uint8Array): Value {
  const bytes = typedArrayBytes(data);
  return ownValue(duckdb.duckdb_create_blob(nonEmpty(bytes), bytes.byteLength) as Pointer | null);
}

/**
 * True for the bit strings DuckDB can read: a padding byte below 8 that leaves a bit
 * count of zero or more. DuckDB asserts this only in debug builds; past it, its BIT
 * to VARCHAR cast writes beyond its buffer or throws a C++ exception, and either one
 * ends the process. The official binding passes such bytes on and crashes.
 */
function validBitString(bytes: Uint8Array): boolean {
  const padding = bytes[0];
  return padding !== undefined && padding < 8 && (bytes.length > 1 || padding === 0);
}

export function create_bit(data: Uint8Array): Value {
  const bytes = typedArrayBytes(data);
  if (!validBitString(bytes)) throw new Error("Failed to create bit value: invalid padding");
  const bit = structWithData("bit", {}, bytes);
  return ownValue(shim.dbs_create_bit(bit) as Pointer | null);
}

export function create_uuid(input: bigint): Value {
  return ownValue(shim.dbs_create_uuid(encode("uhugeint", uhugeintFromBigInt(input))) as Pointer | null);
}

export function create_null_value(): Value {
  return ownValue(duckdb.duckdb_create_null_value() as Pointer | null);
}

// --- get ----------------------------------------------------------------------------

export function get_bool(value: Value): boolean {
  return duckdb.duckdb_get_bool(presentValuePointer(value));
}

export function get_int8(value: Value): number {
  return duckdb.duckdb_get_int8(presentValuePointer(value));
}

export function get_uint8(value: Value): number {
  return duckdb.duckdb_get_uint8(presentValuePointer(value));
}

export function get_int16(value: Value): number {
  return duckdb.duckdb_get_int16(presentValuePointer(value));
}

export function get_uint16(value: Value): number {
  return duckdb.duckdb_get_uint16(presentValuePointer(value));
}

export function get_int32(value: Value): number {
  return duckdb.duckdb_get_int32(presentValuePointer(value));
}

export function get_uint32(value: Value): number {
  return duckdb.duckdb_get_uint32(presentValuePointer(value));
}

export function get_int64(value: Value): bigint {
  return BigInt(duckdb.duckdb_get_int64(presentValuePointer(value)));
}

export function get_uint64(value: Value): bigint {
  return BigInt(duckdb.duckdb_get_uint64(presentValuePointer(value)));
}

export function get_hugeint(value: Value): bigint {
  return getStruct<bigint>("hugeint", shim.dbs_get_hugeint, value);
}

export function get_uhugeint(value: Value): bigint {
  return getStruct<bigint>("uhugeint", shim.dbs_get_uhugeint, value);
}

export function get_bignum(value: Value): bigint {
  const bignum = getStruct<{ data: number; size: bigint; is_negative: boolean }>("bignum", shim.dbs_get_bignum, value);
  return bigIntFromBignum(takeData(bignum.data, bignum.size), bignum.is_negative);
}

export function get_decimal(value: Value): Decimal {
  // duckdb_get_decimal reads a NULL value without throwing.
  return getStruct<Decimal>("decimal", shim.dbs_get_decimal, value, presentValuePointer);
}

export function get_float(value: Value): number {
  return duckdb.duckdb_get_float(presentValuePointer(value));
}

export function get_double(value: Value): number {
  return duckdb.duckdb_get_double(presentValuePointer(value));
}

export function get_date(value: Value): Date_ {
  return getStruct<Date_>("date", shim.dbs_get_date, value);
}

export function get_time(value: Value): Time {
  return getStruct<Time>("time", shim.dbs_get_time, value);
}

export function get_time_ns(value: Value): TimeNS {
  return getStruct<TimeNS>("time_ns", shim.dbs_get_time_ns, value);
}

export function get_time_tz(value: Value): TimeTZ {
  return getStruct<TimeTZ>("time_tz", shim.dbs_get_time_tz, value);
}

export function get_timestamp(value: Value): Timestamp {
  return getStruct<Timestamp>("timestamp", shim.dbs_get_timestamp, value);
}

export function get_timestamp_tz(value: Value): Timestamp {
  return getStruct<Timestamp>("timestamp", shim.dbs_get_timestamp_tz, value);
}

export function get_timestamp_tz_ns(value: Value): TimestampNanoseconds {
  return getStruct<TimestampNanoseconds>("timestamp_ns", shim.dbs_get_timestamp_tz_ns, value);
}

export function get_timestamp_s(value: Value): TimestampSeconds {
  return getStruct<TimestampSeconds>("timestamp_s", shim.dbs_get_timestamp_s, value);
}

export function get_timestamp_ms(value: Value): TimestampMilliseconds {
  return getStruct<TimestampMilliseconds>("timestamp_ms", shim.dbs_get_timestamp_ms, value);
}

export function get_timestamp_ns(value: Value): TimestampNanoseconds {
  return getStruct<TimestampNanoseconds>("timestamp_ns", shim.dbs_get_timestamp_ns, value);
}

export function get_interval(value: Value): Interval {
  return getStruct<Interval>("interval", shim.dbs_get_interval, value);
}

/**
 * The value owns its type and frees it with itself, so the handle borrows the
 * pointer and keeps the value reachable for as long as the type is.
 */
export function get_value_type(value: Value): LogicalType {
  const handle = handleOf(value, "value");
  const type = duckdb.duckdb_get_value_type(handle.destroyRequested ? null : handle.ptr) as Pointer | null;
  return borrow("logical type", type, handle) as unknown as LogicalType;
}

export function get_blob(value: Value): Uint8Array {
  const blob = getStruct<{ data: number; size: bigint }>("blob", shim.dbs_get_blob, value);
  return toBuffer(takeData(blob.data, blob.size));
}

export function get_bit(value: Value): Uint8Array {
  const bit = getStruct<{ data: number; size: bigint }>("bit", shim.dbs_get_bit, value);
  return toBuffer(takeData(bit.data, bit.size));
}

export function get_uuid(value: Value): bigint {
  return getStruct<bigint>("uhugeint", shim.dbs_get_uuid, value);
}

export function get_varchar(value: Value): string {
  const text = takeCString(duckdb.duckdb_get_varchar(presentValuePointer(value)) as Pointer | null);
  // Napi::String::New throws this for the null DuckDB returns when malloc fails.
  if (text === null) throw new Error("Invalid argument");
  return text;
}

export function is_null_value(value: Value): boolean {
  return duckdb.duckdb_is_null_value(valuePointer(value));
}

// --- nested values ------------------------------------------------------------------

/**
 * duckdb_create_struct_value reads one value per struct child. The official
 * binding passes only as many slots as the caller gave values, so too few
 * values read past the array; here the array has a slot per child, and a
 * missing value is a null slot, which DuckDB reports as a failure.
 */
export function create_struct_value(logical_type: LogicalType, values: readonly Value[]): Value {
  const type = logicalTypePointer(logical_type);
  const valuesArray = expectArray(values);
  const childCount = Number(duckdb.duckdb_struct_type_child_count(type));
  const pointers = valuePointers(valuesArray, Math.max(valuesArray.length, childCount));
  const struct = duckdb.duckdb_create_struct_value(type, pointers) as Pointer | null;
  return ownValueOrThrow(struct, "Failed to create struct value");
}

export function create_list_value(logical_type: LogicalType, values: readonly Value[]): Value {
  const type = logicalTypePointer(logical_type);
  const valuesArray = expectArray(values);
  const pointers = valuePointers(valuesArray, valuesArray.length);
  const list = duckdb.duckdb_create_list_value(type, pointers, valuesArray.length) as Pointer | null;
  return ownValueOrThrow(list, "Failed to create list value");
}

export function create_array_value(logical_type: LogicalType, values: readonly Value[]): Value {
  const type = logicalTypePointer(logical_type);
  const valuesArray = expectArray(values);
  const pointers = valuePointers(valuesArray, valuesArray.length);
  const array = duckdb.duckdb_create_array_value(type, pointers, valuesArray.length) as Pointer | null;
  return ownValueOrThrow(array, "Failed to create array value");
}

export function create_map_value(map_type: LogicalType, keys: readonly Value[], values: readonly Value[]): Value {
  const type = logicalTypePointer(map_type);
  const keysArray = expectArray(keys);
  const valuesArray = expectArray(values);
  if (keysArray.length !== valuesArray.length) {
    throw new Error("Failed to create map value: must have same number of keys and values");
  }
  const count = keysArray.length;
  const keyPointers = new BigUint64Array(Math.max(count, 1));
  const valuePointerArray = new BigUint64Array(Math.max(count, 1));
  for (let i = 0; i < count; i++) {
    keyPointers[i] = BigInt(valuePointer(keysArray[i]) ?? 0);
    valuePointerArray[i] = BigInt(valuePointer(valuesArray[i]) ?? 0);
  }
  const map = duckdb.duckdb_create_map_value(type, keyPointers, valuePointerArray, count) as Pointer | null;
  return ownValueOrThrow(map, "Failed to create map value");
}

export function create_union_value(union_type: LogicalType, tag_index: number, value: Value): Value {
  const type = logicalTypePointer(union_type);
  const tag = uint32FromNumber(tag_index);
  const member = valuePointer(value);
  const union = duckdb.duckdb_create_union_value(type, tag, member) as Pointer | null;
  return ownValueOrThrow(union, "Failed to create union value");
}

export function create_enum_value(logical_type: LogicalType, value: number): Value {
  const type = logicalTypePointer(logical_type);
  const index = integerFromNumber(value, "uint32");
  return ownValueOrThrow(duckdb.duckdb_create_enum_value(type, index) as Pointer | null, "Failed to create enum value");
}

export function get_enum_value(value: Value): number {
  return Number(duckdb.duckdb_get_enum_value(valuePointer(value)));
}

export function get_map_size(value: Value): number {
  return Number(duckdb.duckdb_get_map_size(valuePointer(value)));
}

export function get_map_key(value: Value, index: number): Value {
  const pointer = valuePointer(value);
  const position = uint32FromNumber(index);
  return ownValueOrThrow(duckdb.duckdb_get_map_key(pointer, position) as Pointer | null, "Failed to get map key");
}

export function get_map_value(value: Value, index: number): Value {
  const pointer = valuePointer(value);
  const position = uint32FromNumber(index);
  return ownValueOrThrow(duckdb.duckdb_get_map_value(pointer, position) as Pointer | null, "Failed to get map value");
}

export function get_list_size(value: Value): number {
  return Number(duckdb.duckdb_get_list_size(valuePointer(value)));
}

export function get_list_child(value: Value, index: number): Value {
  const pointer = valuePointer(value);
  const position = uint32FromNumber(index);
  return ownValueOrThrow(duckdb.duckdb_get_list_child(pointer, position) as Pointer | null, "Failed to get list child");
}

export function get_struct_child(value: Value, index: number): Value {
  const pointer = valuePointer(value);
  const position = uint32FromNumber(index);
  const child = duckdb.duckdb_get_struct_child(pointer, position) as Pointer | null;
  return ownValueOrThrow(child, "Failed to get struct child");
}
