// Query, prepared statement, bind, pending result, extracted statement and
// result functions of the @duckdb/node-bindings contract. Semantics and error
// text follow the official binding (bindings/src/duckdb_node_bindings.cpp,
// promise_workers.h and conversion_helpers.h at the vendored tag).
import type { Pointer } from "bun:ffi";
import type {
  Connection,
  DataChunk,
  Date_,
  Decimal,
  ExtractedStatements,
  ExtractedStatementsAndCount,
  Interval,
  LogicalType,
  PendingResult,
  PendingState,
  PreparedStatement,
  Result,
  ResultType,
  StatementType,
  Time,
  Timestamp,
  Type,
  Value,
} from "../generated/contract.ts";
import {
  checkIndexInRange,
  checkOneBasedIndexInRange,
  dateFromObject,
  decimalFromObject,
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
  uint64FromBigInt,
} from "../runtime/convert.ts";
import { jobOut0, jobOut1, runJob } from "../runtime/dispatch.ts";
import { Handle, type Kind, unwrap } from "../runtime/handle.ts";
import { own } from "../runtime/kinds.ts";
import { cstr, encode, type LayoutName, readCString, slot, slotValue, takeCString, utf8 } from "../runtime/marshal.ts";
import { duckdb, shim } from "../runtime/native.ts";
import { RingOp, record } from "../runtime/ring.ts";
import { callContext } from "../runtime/trace.ts";

/** The duckdb_type value DuckDB returns for an out-of-range column. */
const DUCKDB_TYPE_INVALID = 0;

function asHandle<T>(handle: Handle): T {
  return handle as unknown as T;
}

/** The pointer and the handle behind a contract value, for a job that must hold the handle. */
function claim(value: unknown, kind: Kind): { ptr: Pointer | null; handle: Handle } {
  const ptr = unwrap(value, kind);
  return { ptr, handle: value as Handle };
}

/** The handle behind `value` without the destroyed check, for the idempotent `*_sync` destroys. */
function handleForDestroy(value: unknown, kind: Kind): Handle {
  if (!(value instanceof Handle) || value.kind !== kind) throw new Error(`Invalid ${kind} argument`);
  return value;
}

/** node-addon-api's Number::Uint32Value: the value modulo 2^32, as an index the C API takes. */
function u32(value: unknown): number {
  return expectNumber(value) >>> 0;
}

function resultFrom(job: Pointer): Result {
  return asHandle(own("result", jobOut0(job) as Pointer));
}

function preparedFrom(job: Pointer): PreparedStatement {
  return asHandle(own("prepared statement", jobOut0(job) as Pointer));
}

// --- query ----------------------------------------------------------------------------

export function query(connection: Connection, sql: string): Promise<Result> {
  const { ptr, handle } = claim(connection, "connection");
  const { bytes, length } = utf8(expectString(sql));
  return runJob(
    callContext("query", sql),
    [handle],
    () => shim.dbs_job_query(ptr, bytes, length) as Pointer | null,
    resultFrom,
  );
}

// --- prepared statements ----------------------------------------------------------------

export function prepare(connection: Connection, sql: string): Promise<PreparedStatement> {
  const { ptr, handle } = claim(connection, "connection");
  const { bytes, length } = utf8(expectString(sql));
  return runJob(
    callContext("prepare", sql),
    [handle],
    () => shim.dbs_job_prepare(ptr, bytes, length) as Pointer | null,
    preparedFrom,
  );
}

export function destroy_prepare_sync(prepared_statement: PreparedStatement): void {
  const handle = handleForDestroy(prepared_statement, "prepared statement");
  record(RingOp.destroyPrepared, handle.ptr);
  handle.requestDestroy();
}

export function nparams(prepared_statement: PreparedStatement): number {
  return Number(duckdb.duckdb_nparams(unwrap(prepared_statement, "prepared statement")));
}

export function parameter_name(prepared_statement: PreparedStatement, index: number): string {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  const name = takeCString(duckdb.duckdb_parameter_name(ptr, i) as Pointer | null);
  if (name === null) throwIndexOutOfRange(i, Number(duckdb.duckdb_nparams(ptr)), "parameter");
  return name;
}

export function param_type(prepared_statement: PreparedStatement, index: number): Type {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  checkOneBasedIndexInRange(i, Number(duckdb.duckdb_nparams(ptr)), "parameter");
  return duckdb.duckdb_param_type(ptr, i) as Type;
}

export function param_logical_type(prepared_statement: PreparedStatement, index: number): LogicalType {
  const type = duckdb.duckdb_param_logical_type(
    unwrap(prepared_statement, "prepared statement"),
    u32(index),
  ) as Pointer | null;
  if (type === null) throw new Error("Failed to get param logical type");
  return asHandle(own("logical type", type));
}

export function clear_bindings(prepared_statement: PreparedStatement): void {
  if (duckdb.duckdb_clear_bindings(unwrap(prepared_statement, "prepared statement"))) {
    throw new Error("Failed to clear bindings");
  }
}

export function prepared_statement_type(prepared_statement: PreparedStatement): StatementType {
  return duckdb.duckdb_prepared_statement_type(unwrap(prepared_statement, "prepared statement")) as StatementType;
}

export function prepared_statement_column_count(prepared_statement: PreparedStatement): number {
  return Number(duckdb.duckdb_prepared_statement_column_count(unwrap(prepared_statement, "prepared statement")));
}

export function prepared_statement_column_name(prepared_statement: PreparedStatement, index: number): string {
  const name = takeCString(
    duckdb.duckdb_prepared_statement_column_name(
      unwrap(prepared_statement, "prepared statement"),
      u32(index),
    ) as Pointer | null,
  );
  if (name === null) throw new Error("Failed to get prepared statement column name");
  return name;
}

export function prepared_statement_column_logical_type(
  prepared_statement: PreparedStatement,
  index: number,
): LogicalType {
  const type = duckdb.duckdb_prepared_statement_column_logical_type(
    unwrap(prepared_statement, "prepared statement"),
    u32(index),
  ) as Pointer | null;
  if (type === null) throw new Error("Failed to get prepared statement column logical type");
  return asHandle(own("logical type", type));
}

export function prepared_statement_column_type(prepared_statement: PreparedStatement, index: number): Type {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  checkIndexInRange(i, Number(duckdb.duckdb_prepared_statement_column_count(ptr)), "column");
  return duckdb.duckdb_prepared_statement_column_type(ptr, i) as Type;
}

// --- bind -------------------------------------------------------------------------------

/** ThrowBindError: "Failed to bind <type>", plus DuckDB's prepare error when it has one. */
function bindOrThrow(ptr: Pointer | null, typeName: string, failed: number): void {
  if (!failed) return;
  const error = readCString(duckdb.duckdb_prepare_error(ptr) as Pointer | null);
  throw new Error(error === null ? `Failed to bind ${typeName}` : `Failed to bind ${typeName}: ${error}`);
}

/** Binds a struct the C API takes by value, through the shim's by-pointer wrapper. */
function bindStruct(
  prepared_statement: PreparedStatement,
  index: number,
  typeName: string,
  layout: LayoutName,
  value: unknown,
  bind: (ptr: Pointer | null, index: number, value: Uint8Array) => number,
): void {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  bindOrThrow(ptr, typeName, bind(ptr, i, encode(layout, value)));
}

function bindInteger(
  prepared_statement: PreparedStatement,
  index: number,
  type: IntegerType,
  value: unknown,
  bind: (ptr: Pointer | null, index: number, value: number) => number,
): void {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  bindOrThrow(ptr, type, bind(ptr, i, integerFromNumber(value, type)));
}

export function bind_value(prepared_statement: PreparedStatement, index: number, value: Value): void {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  bindOrThrow(ptr, "value", duckdb.duckdb_bind_value(ptr, i, unwrap(value, "value")));
}

export function bind_parameter_index(prepared_statement: PreparedStatement, name: string): number {
  const out = slot();
  if (
    duckdb.duckdb_bind_parameter_index(unwrap(prepared_statement, "prepared statement"), out, cstr(expectString(name)))
  ) {
    throw new Error("Failed to retrieve bind parameter index");
  }
  return Number(out[0]);
}

export function bind_boolean(prepared_statement: PreparedStatement, index: number, bool: boolean): void {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  bindOrThrow(ptr, "boolean", duckdb.duckdb_bind_boolean(ptr, i, expectBoolean(bool)));
}

export function bind_int8(prepared_statement: PreparedStatement, index: number, int8: number): void {
  bindInteger(prepared_statement, index, "int8", int8, (p, i, v) => duckdb.duckdb_bind_int8(p, i, v));
}

export function bind_int16(prepared_statement: PreparedStatement, index: number, int16: number): void {
  bindInteger(prepared_statement, index, "int16", int16, (p, i, v) => duckdb.duckdb_bind_int16(p, i, v));
}

export function bind_int32(prepared_statement: PreparedStatement, index: number, int32: number): void {
  bindInteger(prepared_statement, index, "int32", int32, (p, i, v) => duckdb.duckdb_bind_int32(p, i, v));
}

export function bind_int64(prepared_statement: PreparedStatement, index: number, int64: bigint): void {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  const value = int64FromBigInt(int64, "bigint");
  bindOrThrow(ptr, "int64", duckdb.duckdb_bind_int64(ptr, i, value));
}

export function bind_hugeint(prepared_statement: PreparedStatement, index: number, hugeint: bigint): void {
  const value = hugeintFromBigInt(hugeint);
  bindStruct(prepared_statement, index, "hugeint", "hugeint", value, (p, i, v) => shim.dbs_bind_hugeint(p, i, v));
}

export function bind_uhugeint(prepared_statement: PreparedStatement, index: number, uhugeint: bigint): void {
  const value = uhugeintFromBigInt(uhugeint);
  bindStruct(prepared_statement, index, "uhugeint", "uhugeint", value, (p, i, v) => shim.dbs_bind_uhugeint(p, i, v));
}

export function bind_decimal(prepared_statement: PreparedStatement, index: number, decimal: Decimal): void {
  const value = decimalFromObject(decimal);
  bindStruct(prepared_statement, index, "decimal", "decimal", value, (p, i, v) => shim.dbs_bind_decimal(p, i, v));
}

export function bind_uint8(prepared_statement: PreparedStatement, index: number, uint8: number): void {
  bindInteger(prepared_statement, index, "uint8", uint8, (p, i, v) => duckdb.duckdb_bind_uint8(p, i, v));
}

export function bind_uint16(prepared_statement: PreparedStatement, index: number, uint16: number): void {
  bindInteger(prepared_statement, index, "uint16", uint16, (p, i, v) => duckdb.duckdb_bind_uint16(p, i, v));
}

export function bind_uint32(prepared_statement: PreparedStatement, index: number, uint32: number): void {
  bindInteger(prepared_statement, index, "uint32", uint32, (p, i, v) => duckdb.duckdb_bind_uint32(p, i, v));
}

export function bind_uint64(prepared_statement: PreparedStatement, index: number, uint64: bigint): void {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  const value = uint64FromBigInt(uint64, "bigint");
  bindOrThrow(ptr, "uint64", duckdb.duckdb_bind_uint64(ptr, i, value));
}

export function bind_float(prepared_statement: PreparedStatement, index: number, float: number): void {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  bindOrThrow(ptr, "float", duckdb.duckdb_bind_float(ptr, i, expectNumber(float)));
}

export function bind_double(prepared_statement: PreparedStatement, index: number, double: number): void {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  bindOrThrow(ptr, "double", duckdb.duckdb_bind_double(ptr, i, expectNumber(double)));
}

export function bind_date(prepared_statement: PreparedStatement, index: number, date: Date_): void {
  const value = dateFromObject(date);
  bindStruct(prepared_statement, index, "date", "date", value, (p, i, v) => shim.dbs_bind_date(p, i, v));
}

export function bind_time(prepared_statement: PreparedStatement, index: number, time: Time): void {
  const value = timeFromObject(time);
  bindStruct(prepared_statement, index, "time", "time", value, (p, i, v) => shim.dbs_bind_time(p, i, v));
}

export function bind_timestamp(prepared_statement: PreparedStatement, index: number, timestamp: Timestamp): void {
  const value = timestampFromObject(timestamp);
  bindStruct(prepared_statement, index, "timestamp", "timestamp", value, (p, i, v) => shim.dbs_bind_timestamp(p, i, v));
}

export function bind_timestamp_tz(prepared_statement: PreparedStatement, index: number, timestamp: Timestamp): void {
  const value = timestampFromObject(timestamp);
  bindStruct(prepared_statement, index, "timestamp_tz", "timestamp", value, (p, i, v) =>
    shim.dbs_bind_timestamp_tz(p, i, v),
  );
}

export function bind_interval(prepared_statement: PreparedStatement, index: number, interval: Interval): void {
  const value = intervalFromObject(interval);
  bindStruct(prepared_statement, index, "interval", "interval", value, (p, i, v) => shim.dbs_bind_interval(p, i, v));
}

export function bind_varchar(prepared_statement: PreparedStatement, index: number, varchar: string): void {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  const { bytes, length } = utf8(expectString(varchar));
  bindOrThrow(ptr, "varchar", duckdb.duckdb_bind_varchar_length(ptr, i, bytes, length));
}

export function bind_blob(prepared_statement: PreparedStatement, index: number, data: Uint8Array): void {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  // A zero-length view still needs a valid address; DuckDB reads none of it.
  const bytes = data.byteLength === 0 ? new Uint8Array(1) : data;
  bindOrThrow(ptr, "blob", duckdb.duckdb_bind_blob(ptr, i, bytes, data.byteLength));
}

export function bind_null(prepared_statement: PreparedStatement, index: number): void {
  const ptr = unwrap(prepared_statement, "prepared statement");
  const i = u32(index);
  bindOrThrow(ptr, "null", duckdb.duckdb_bind_null(ptr, i));
}

// --- execute ----------------------------------------------------------------------------

export function execute_prepared(prepared_statement: PreparedStatement): Promise<Result> {
  const { ptr, handle } = claim(prepared_statement, "prepared statement");
  return runJob(
    callContext("execute_prepared"),
    [handle],
    () => shim.dbs_job_execute_prepared(ptr) as Pointer | null,
    resultFrom,
  );
}

export function execute_prepared_streaming(prepared_statement: PreparedStatement): Promise<Result> {
  const { ptr, handle } = claim(prepared_statement, "prepared statement");
  return runJob(
    callContext("execute_prepared_streaming"),
    [handle],
    () => shim.dbs_job_execute_prepared_streaming(ptr) as Pointer | null,
    resultFrom,
  );
}

// --- pending results ----------------------------------------------------------------------

function pendingFrom(
  prepared_statement: PreparedStatement,
  start: (ptr: Pointer | null, out: BigUint64Array) => number,
): PendingResult {
  const out = slot();
  if (start(unwrap(prepared_statement, "prepared statement"), out)) {
    const pending = slotValue(out);
    const error = readCString(duckdb.duckdb_pending_error(pending) as Pointer | null);
    duckdb.duckdb_destroy_pending(out);
    throw new Error(error ?? "Failed to create pending result");
  }
  return asHandle(own("pending result", slotValue(out) as Pointer));
}

export function pending_prepared(prepared_statement: PreparedStatement): PendingResult {
  return pendingFrom(prepared_statement, (p, out) => duckdb.duckdb_pending_prepared(p, out));
}

export function pending_prepared_streaming(prepared_statement: PreparedStatement): PendingResult {
  return pendingFrom(prepared_statement, (p, out) => duckdb.duckdb_pending_prepared_streaming(p, out));
}

export function destroy_pending_sync(pending_result: PendingResult): void {
  const handle = handleForDestroy(pending_result, "pending result");
  record(RingOp.destroyPending, handle.ptr);
  handle.requestDestroy();
}

export function pending_error(pending_result: PendingResult): string {
  return readCString(duckdb.duckdb_pending_error(unwrap(pending_result, "pending result")) as Pointer | null) ?? "";
}

export function pending_execute_task(pending_result: PendingResult): PendingState {
  const ptr = unwrap(pending_result, "pending result");
  record(RingOp.pendingExecuteTask, ptr);
  return duckdb.duckdb_pending_execute_task(ptr) as PendingState;
}

export function pending_execute_check_state(pending_result: PendingResult): PendingState {
  return duckdb.duckdb_pending_execute_check_state(unwrap(pending_result, "pending result")) as PendingState;
}

export function execute_pending(pending_result: PendingResult): Promise<Result> {
  const { ptr, handle } = claim(pending_result, "pending result");
  return runJob(
    callContext("execute_pending"),
    [handle],
    () => shim.dbs_job_execute_pending(ptr) as Pointer | null,
    resultFrom,
  );
}

export function pending_execution_is_finished(pending_state: PendingState): boolean {
  return duckdb.duckdb_pending_execution_is_finished(u32(pending_state));
}

// --- extracted statements -------------------------------------------------------------------

export function extract_statements(connection: Connection, sql: string): Promise<ExtractedStatementsAndCount> {
  const { ptr, handle } = claim(connection, "connection");
  const { bytes, length } = utf8(expectString(sql));
  return runJob(
    callContext("extract_statements", sql),
    [handle],
    () => shim.dbs_job_extract_statements(ptr, bytes, length) as Pointer | null,
    (job) => ({
      extracted_statements: asHandle<ExtractedStatements>(own("extracted statements", jobOut0(job) as Pointer)),
      statement_count: jobOut1(job),
    }),
  );
}

export function prepare_extracted_statement(
  connection: Connection,
  extracted_statements: ExtractedStatements,
  index: number,
): Promise<PreparedStatement> {
  const { ptr, handle } = claim(connection, "connection");
  const extracted = claim(extracted_statements, "extracted statements");
  const i = u32(index);
  return runJob(
    callContext("prepare_extracted_statement"),
    [handle, extracted.handle],
    () => shim.dbs_job_prepare_extracted_statement(ptr, extracted.ptr, i) as Pointer | null,
    preparedFrom,
  );
}

export function extract_statements_error(extracted_statements: ExtractedStatements): string {
  const ptr = unwrap(extracted_statements, "extracted statements");
  return readCString(duckdb.duckdb_extract_statements_error(ptr) as Pointer | null) ?? "";
}

// --- results ------------------------------------------------------------------------------

export function destroy_result_sync(result: Result): void {
  const handle = handleForDestroy(result, "result");
  // A no-op if already destroyed; deferred while fetch_chunk is in flight.
  if (handle.destroyRequested) return;
  record(RingOp.destroyResult, handle.ptr);
  handle.requestDestroy();
}

function columnCount(ptr: Pointer | null): number {
  return Number(duckdb.duckdb_column_count(ptr));
}

export function column_name(result: Result, column_index: number): string {
  const ptr = unwrap(result, "result");
  const i = u32(column_index);
  const name = readCString(duckdb.duckdb_column_name(ptr, i) as Pointer | null);
  if (name === null) throwIndexOutOfRange(i, columnCount(ptr), "column");
  return name;
}

export function column_type(result: Result, column_index: number): Type {
  const ptr = unwrap(result, "result");
  const i = u32(column_index);
  const type = duckdb.duckdb_column_type(ptr, i);
  if (type === DUCKDB_TYPE_INVALID) throwIndexOutOfRange(i, columnCount(ptr), "column");
  return type as Type;
}

export function result_statement_type(result: Result): StatementType {
  return shim.dbs_result_statement_type(unwrap(result, "result")) as StatementType;
}

export function column_logical_type(result: Result, column_index: number): LogicalType {
  const ptr = unwrap(result, "result");
  const i = u32(column_index);
  const type = duckdb.duckdb_column_logical_type(ptr, i) as Pointer | null;
  if (type === null) throwIndexOutOfRange(i, columnCount(ptr), "column");
  return asHandle(own("logical type", type));
}

export function column_count(result: Result): number {
  return columnCount(unwrap(result, "result"));
}

export function rows_changed(result: Result): number {
  return Number(duckdb.duckdb_rows_changed(unwrap(result, "result")));
}

export function result_return_type(result: Result): ResultType {
  return shim.dbs_result_return_type(unwrap(result, "result")) as ResultType;
}

export function fetch_chunk(result: Result): Promise<DataChunk | null> {
  const { ptr, handle } = claim(result, "result");
  return runJob(
    callContext("fetch_chunk"),
    [handle],
    () => shim.dbs_job_fetch_chunk(ptr) as Pointer | null,
    (job) => {
      const chunk = jobOut0(job);
      return chunk === null ? null : asHandle<DataChunk>(own("data chunk", chunk));
    },
  );
}

export function row_count(result: Result): number {
  return Number(duckdb.duckdb_row_count(unwrap(result, "result")));
}

export function result_get_chunk(result: Result, chunkIndex: number): DataChunk {
  const chunk = shim.dbs_result_get_chunk(unwrap(result, "result"), u32(chunkIndex)) as Pointer | null;
  if (chunk === null) throw new Error("Failed to get data chunk. Only supported for materialized results.");
  return asHandle(own("data chunk", chunk));
}

export function result_is_streaming(result: Result): boolean {
  return shim.dbs_result_is_streaming(unwrap(result, "result"));
}

export function result_chunk_count(result: Result): number {
  return Number(shim.dbs_result_chunk_count(unwrap(result, "result")));
}
