// Appender functions of the @duckdb/node-bindings contract. Semantics and
// error text follow the official binding (bindings/src/duckdb_node_bindings.cpp
// at the vendored tag): every failing call throws DuckDB's appender error.
import type { Pointer } from "bun:ffi";
import type {
  Appender,
  Connection,
  DataChunk,
  Date_,
  Interval,
  LogicalType,
  Time,
  Timestamp,
  Value,
} from "../generated/contract.ts";
import {
  dateFromObject,
  expectBoolean,
  expectNumber,
  expectString,
  hugeintFromBigInt,
  type IntegerType,
  int64FromBigInt,
  integerFromNumber,
  intervalFromObject,
  throwIndexOutOfRange,
  timeFromObject,
  timestampFromObject,
  uhugeintFromBigInt,
  uint32FromNumber,
  uint64FromBigInt,
} from "../runtime/convert.ts";
import { type Handle, unwrap } from "../runtime/handle.ts";
import { own } from "../runtime/kinds.ts";
import { cstr, encode, type LayoutName, readCString, slot, slotValue, utf8 } from "../runtime/marshal.ts";
import { duckdb, shim } from "../runtime/native.ts";
import { RingOp, record } from "../runtime/ring.ts";

function asHandle<T>(handle: Handle): T {
  return handle as unknown as T;
}

/** duckdb_appender_error is set whenever an appender call fails. */
function appenderError(appender: Pointer | null): Error {
  return new Error(readCString(duckdb.duckdb_appender_error(appender) as Pointer | null) ?? "Unknown appender error");
}

function check(appender: Pointer | null, failed: number): void {
  if (failed) throw appenderError(appender);
}

// --- create ----------------------------------------------------------------------------------

function connectionForAppender(connection: Connection): Pointer {
  const ptr = unwrap(connection, "connection");
  if (ptr === null) throw new Error("Failed to create appender: connection disconnected");
  return ptr;
}

/** A nullable name as the C API takes it: null, or a NUL-terminated copy. */
function optionalName(name: string | null): Buffer | null {
  return name === null ? null : cstr(expectString(name));
}

/** Wraps the created appender, or throws its error after destroying it, as the official binding does. */
function created(failed: number, out: BigUint64Array): Appender {
  if (failed) {
    const error = appenderError(slotValue(out));
    duckdb.duckdb_appender_destroy(out);
    throw error;
  }
  return asHandle(own("appender", slotValue(out) as Pointer));
}

export function appender_create(connection: Connection, schema: string | null, table: string): Appender {
  const ptr = connectionForAppender(connection);
  const schemaName = optionalName(schema);
  const tableName = cstr(expectString(table));
  const out = slot();
  return created(duckdb.duckdb_appender_create(ptr, schemaName, tableName, out), out);
}

export function appender_create_ext(
  connection: Connection,
  catalog: string | null,
  schema: string | null,
  table: string,
): Appender {
  const ptr = connectionForAppender(connection);
  const catalogName = optionalName(catalog);
  const schemaName = optionalName(schema);
  const tableName = cstr(expectString(table));
  const out = slot();
  return created(duckdb.duckdb_appender_create_ext(ptr, catalogName, schemaName, tableName, out), out);
}

// --- columns, flush, close -------------------------------------------------------------------

export function appender_column_count(appender: Appender): number {
  return Number(duckdb.duckdb_appender_column_count(unwrap(appender, "appender")));
}

export function appender_column_type(appender: Appender, column_index: number): LogicalType {
  const ptr = unwrap(appender, "appender");
  const index = uint32FromNumber(column_index);
  const type = duckdb.duckdb_appender_column_type(ptr, index) as Pointer | null;
  if (type === null) throwIndexOutOfRange(index, Number(duckdb.duckdb_appender_column_count(ptr)), "column");
  return asHandle(own("logical type", type));
}

export function appender_flush_sync(appender: Appender): void {
  const ptr = unwrap(appender, "appender");
  record(RingOp.appenderFlush, ptr);
  check(ptr, duckdb.duckdb_appender_flush(ptr));
}

export function appender_clear(appender: Appender): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, duckdb.duckdb_appender_clear(ptr));
}

export function appender_close_sync(appender: Appender): void {
  const ptr = unwrap(appender, "appender");
  record(RingOp.appenderClose, ptr);
  check(ptr, duckdb.duckdb_appender_close(ptr));
}

export function appender_end_row(appender: Appender): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, duckdb.duckdb_appender_end_row(ptr));
}

// --- append ----------------------------------------------------------------------------------

export function append_default(appender: Appender): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, duckdb.duckdb_append_default(ptr));
}

export function append_bool(appender: Appender, bool: boolean): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, duckdb.duckdb_append_bool(ptr, expectBoolean(bool)));
}

function appendInteger(
  appender: Appender,
  type: IntegerType,
  value: unknown,
  append: (ptr: Pointer | null, value: number) => number,
): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, append(ptr, integerFromNumber(value, type)));
}

/** Appends a by-value struct through the shim's pointer wrapper. */
/**
 * Appends a struct the C API takes by value. `value` converts the argument only
 * after the appender is checked, so a bad appender is reported first, as the
 * official binding reads its arguments in order.
 */
function appendStruct(
  appender: Appender,
  layout: LayoutName,
  value: () => unknown,
  append: (ptr: Pointer | null, value: Uint8Array) => number,
): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, append(ptr, encode(layout, value())));
}

export function append_int8(appender: Appender, int8: number): void {
  appendInteger(appender, "int8", int8, (p, v) => duckdb.duckdb_append_int8(p, v));
}

export function append_int16(appender: Appender, int16: number): void {
  appendInteger(appender, "int16", int16, (p, v) => duckdb.duckdb_append_int16(p, v));
}

export function append_int32(appender: Appender, int32: number): void {
  appendInteger(appender, "int32", int32, (p, v) => duckdb.duckdb_append_int32(p, v));
}

export function append_int64(appender: Appender, int64: bigint): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, duckdb.duckdb_append_int64(ptr, int64FromBigInt(int64, "bigint")));
}

export function append_hugeint(appender: Appender, hugeint: bigint): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, shim.dbs_append_hugeint(ptr, encode("hugeint", hugeintFromBigInt(hugeint))));
}

export function append_uint8(appender: Appender, uint8: number): void {
  appendInteger(appender, "uint8", uint8, (p, v) => duckdb.duckdb_append_uint8(p, v));
}

export function append_uint16(appender: Appender, uint16: number): void {
  appendInteger(appender, "uint16", uint16, (p, v) => duckdb.duckdb_append_uint16(p, v));
}

export function append_uint32(appender: Appender, uint32: number): void {
  appendInteger(appender, "uint32", uint32, (p, v) => duckdb.duckdb_append_uint32(p, v));
}

export function append_uint64(appender: Appender, uint64: bigint): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, duckdb.duckdb_append_uint64(ptr, uint64FromBigInt(uint64, "bigint")));
}

export function append_uhugeint(appender: Appender, uhugeint: bigint): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, shim.dbs_append_uhugeint(ptr, encode("uhugeint", uhugeintFromBigInt(uhugeint))));
}

export function append_float(appender: Appender, float: number): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, duckdb.duckdb_append_float(ptr, expectNumber(float)));
}

export function append_double(appender: Appender, double: number): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, duckdb.duckdb_append_double(ptr, expectNumber(double)));
}

export function append_date(appender: Appender, date: Date_): void {
  appendStruct(
    appender,
    "date",
    () => dateFromObject(date),
    (p, v) => shim.dbs_append_date(p, v),
  );
}

export function append_time(appender: Appender, time: Time): void {
  appendStruct(
    appender,
    "time",
    () => timeFromObject(time),
    (p, v) => shim.dbs_append_time(p, v),
  );
}

export function append_timestamp(appender: Appender, timestamp: Timestamp): void {
  appendStruct(
    appender,
    "timestamp",
    () => timestampFromObject(timestamp),
    (p, v) => shim.dbs_append_timestamp(p, v),
  );
}

export function append_interval(appender: Appender, interval: Interval): void {
  appendStruct(
    appender,
    "interval",
    () => intervalFromObject(interval),
    (p, v) => shim.dbs_append_interval(p, v),
  );
}

export function append_varchar(appender: Appender, varchar: string): void {
  const ptr = unwrap(appender, "appender");
  const { bytes, length } = utf8(expectString(varchar));
  check(ptr, duckdb.duckdb_append_varchar_length(ptr, bytes, length));
}

export function append_blob(appender: Appender, data: Uint8Array): void {
  const ptr = unwrap(appender, "appender");
  if (!ArrayBuffer.isView(data) || data instanceof DataView) throw new Error("Invalid argument");
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // A zero-length view still needs a valid address; DuckDB reads none of it.
  check(ptr, duckdb.duckdb_append_blob(ptr, bytes.byteLength === 0 ? new Uint8Array(1) : bytes, bytes.byteLength));
}

export function append_null(appender: Appender): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, duckdb.duckdb_append_null(ptr));
}

export function append_value(appender: Appender, value: Value): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, duckdb.duckdb_append_value(ptr, unwrap(value, "value")));
}

export function append_data_chunk(appender: Appender, chunk: DataChunk): void {
  const ptr = unwrap(appender, "appender");
  check(ptr, duckdb.duckdb_append_data_chunk(ptr, unwrap(chunk, "data chunk")));
}
