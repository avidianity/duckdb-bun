// Table function functions of the @duckdb/node-bindings contract. Semantics
// and error text follow the official binding (bindings/src/duckdb_node_bindings.cpp
// and table_function_helpers.h at the vendored tag).
//
// As for scalar functions (scalar-function.ts), the callbacks and extra info
// live in one state object per TableFunction, DuckDB holds only ids, and the
// shim's trampolines are set at registration, once the callbacks are known.
import type { Pointer } from "bun:ffi";
import type {
  ClientContext,
  Connection,
  DataChunk,
  LogicalType,
  TableFunction,
  TableFunctionBindFunction,
  TableFunctionBindInfo,
  TableFunctionInfo,
  TableFunctionInitFunction,
  TableFunctionInitInfo,
  TableFunctionMainFunction,
  Value,
} from "../generated/contract.ts";
import { expectBoolean, expectFunction, expectString, int64FromNumber, uint32FromNumber } from "../runtime/convert.ts";
import { allocateId, CallKind, setCallHandler } from "../runtime/dispatch.ts";
import { type Handle, handleOf, type Kind, unwrap } from "../runtime/handle.ts";
import { borrow, own } from "../runtime/kinds.ts";
import { cstr, slot, slotValue } from "../runtime/marshal.ts";
import { duckdb, shim } from "../runtime/native.ts";
import { RingOp, record } from "../runtime/ring.ts";
import { CallbackScope, runInScope, storeUserData, userDataOf } from "../runtime/scope.ts";

function asHandle<T>(handle: Handle): T {
  return handle as unknown as T;
}

interface TableFunctionState {
  extraInfo: unknown;
  bind?: TableFunctionBindFunction;
  init?: TableFunctionInitFunction;
  localInit?: TableFunctionInitFunction;
  main?: TableFunctionMainFunction;
  /** The trampolines last given to DuckDB, or undefined before the first registration. */
  applied?: { bind: boolean; init: boolean; localInit: boolean };
}

const states = new WeakMap<object, TableFunctionState>();

/** The function state behind a callback's info handle. */
const infoStates = new WeakMap<object, TableFunctionState>();

function stateOf(table_function: TableFunction): { ptr: Pointer | null; state: TableFunctionState } {
  const ptr = unwrap(table_function, "table function");
  return { ptr, state: states.get(table_function as object) as TableFunctionState };
}

function extraInfoOf(info: unknown, kind: Kind): object | undefined {
  unwrap(info, kind);
  return infoStates.get(info as object)?.extraInfo as object | undefined;
}

// --- calls from DuckDB ------------------------------------------------------------------------

function callInfo<K extends Kind>(scope: CallbackScope, kind: K, ptr: Pointer, state: TableFunctionState): Handle<K> {
  const info = scope.adopt(borrow(kind, ptr));
  infoStates.set(info, state);
  return info;
}

function setError(set: (info: Pointer, message: Buffer) => void, info: Pointer): (message: string) => void {
  return (message) => set(info, cstr(message));
}

function runInit(state: TableFunctionState, info: Pointer, func: TableFunctionInitFunction | undefined): void {
  const scope = new CallbackScope();
  const handle = callInfo(scope, "table function init info", info, state);
  runInScope(
    scope,
    () => func?.(asHandle(handle)),
    setError((i, m) => duckdb.duckdb_init_set_error(i, m), info),
  );
}

function handlerFor(state: TableFunctionState) {
  return (kind: number, info: Pointer, input: Pointer | null): void => {
    switch (kind) {
      case CallKind.tableBind: {
        const scope = new CallbackScope();
        const handle = callInfo(scope, "table function bind info", info, state);
        runInScope(
          scope,
          () => state.bind?.(asHandle(handle)),
          setError((i, m) => duckdb.duckdb_bind_set_error(i, m), info),
        );
        return;
      }
      case CallKind.tableInit:
        runInit(state, info, state.init);
        return;
      case CallKind.tableLocalInit:
        runInit(state, info, state.localInit);
        return;
      case CallKind.tableMain: {
        const scope = new CallbackScope();
        const handle = callInfo(scope, "table function info", info, state);
        // The shim passes the main function's output chunk as the call's input.
        const output = scope.adopt(borrow("data chunk", input));
        runInScope(
          scope,
          () => state.main?.(asHandle(handle), asHandle<DataChunk>(output)),
          setError((i, m) => duckdb.duckdb_function_set_error(i, m), info),
        );
        return;
      }
    }
  };
}

/**
 * Gives DuckDB the shim's trampolines for the callbacks set so far, under a new
 * id, unless it already has exactly those. Without a main function nothing is
 * set, so DuckDB refuses the registration, as it does in the official binding.
 */
function applyCallbacks(ptr: Pointer, state: TableFunctionState): void {
  if (!state.main) return;
  const wanted = {
    bind: state.bind !== undefined,
    init: state.init !== undefined,
    localInit: state.localInit !== undefined,
  };
  const applied = state.applied;
  if (
    applied &&
    applied.bind === wanted.bind &&
    applied.init === wanted.init &&
    applied.localInit === wanted.localInit
  ) {
    return;
  }
  const id = allocateId();
  setCallHandler(id, handlerFor(state));
  shim.dbs_table_function_set_callbacks(ptr, id, wanted.bind, wanted.init, wanted.localInit);
  state.applied = wanted;
}

// --- the function object ------------------------------------------------------------------------

export function create_table_function(): TableFunction {
  const handle = own("table function", duckdb.duckdb_create_table_function() as Pointer);
  states.set(handle, { extraInfo: undefined });
  return asHandle(handle);
}

export function destroy_table_function_sync(table_function: TableFunction): void {
  // A no-op once destroyed, as duckdb_destroy_table_function is.
  handleOf(table_function, "table function").requestDestroy();
}

export function table_function_set_name(table_function: TableFunction, name: string): void {
  const ptr = unwrap(table_function, "table function");
  duckdb.duckdb_table_function_set_name(ptr, cstr(expectString(name)));
}

export function table_function_add_parameter(table_function: TableFunction, logical_type: LogicalType): void {
  const ptr = unwrap(table_function, "table function");
  duckdb.duckdb_table_function_add_parameter(ptr, unwrap(logical_type, "logical type"));
}

export function table_function_add_named_parameter(
  table_function: TableFunction,
  name: string,
  logical_type: LogicalType,
): void {
  const ptr = unwrap(table_function, "table function");
  const parameterName = cstr(expectString(name));
  duckdb.duckdb_table_function_add_named_parameter(ptr, parameterName, unwrap(logical_type, "logical type"));
}

export function table_function_set_extra_info(table_function: TableFunction, extra_info: object): void {
  stateOf(table_function).state.extraInfo = extra_info;
}

export function table_function_set_bind(table_function: TableFunction, func: TableFunctionBindFunction): void {
  stateOf(table_function).state.bind = expectFunction(func);
}

export function table_function_set_init(table_function: TableFunction, func: TableFunctionInitFunction): void {
  stateOf(table_function).state.init = expectFunction(func);
}

export function table_function_set_local_init(table_function: TableFunction, func: TableFunctionInitFunction): void {
  stateOf(table_function).state.localInit = expectFunction(func);
}

export function table_function_set_function(table_function: TableFunction, func: TableFunctionMainFunction): void {
  stateOf(table_function).state.main = expectFunction(func);
}

export function table_function_supports_projection_pushdown(table_function: TableFunction, pushdown: boolean): void {
  const ptr = unwrap(table_function, "table function");
  duckdb.duckdb_table_function_supports_projection_pushdown(ptr, expectBoolean(pushdown));
}

export function register_table_function(connection: Connection, table_function: TableFunction): void {
  const connectionPtr = unwrap(connection, "connection");
  const { ptr, state } = stateOf(table_function);
  if (ptr !== null) applyCallbacks(ptr, state);
  record(RingOp.registerTableFunction, ptr);
  if (duckdb.duckdb_register_table_function(connectionPtr, ptr)) {
    throw new Error("Failed to register table function");
  }
}

// --- bind ---------------------------------------------------------------------------------------

export function bind_get_extra_info(bind_info: TableFunctionBindInfo): object | undefined {
  return extraInfoOf(bind_info, "table function bind info");
}

export function table_function_get_client_context(bind_info: TableFunctionBindInfo): ClientContext {
  const ptr = unwrap(bind_info, "table function bind info");
  const out = slot();
  duckdb.duckdb_table_function_get_client_context(ptr, out);
  const context = slotValue(out);
  if (context === null) throw new Error("Failed to get client context");
  return asHandle(own("client context", context));
}

export function bind_add_result_column(
  bind_info: TableFunctionBindInfo,
  name: string,
  logical_type: LogicalType,
): void {
  const ptr = unwrap(bind_info, "table function bind info");
  const columnName = cstr(expectString(name));
  duckdb.duckdb_bind_add_result_column(ptr, columnName, unwrap(logical_type, "logical type"));
}

export function bind_get_parameter_count(bind_info: TableFunctionBindInfo): number {
  return Number(duckdb.duckdb_bind_get_parameter_count(unwrap(bind_info, "table function bind info")));
}

export function bind_get_parameter(bind_info: TableFunctionBindInfo, index: number): Value {
  const ptr = unwrap(bind_info, "table function bind info");
  const value = duckdb.duckdb_bind_get_parameter(ptr, uint32FromNumber(index)) as Pointer | null;
  if (value === null) throw new Error("Failed to get parameter");
  return asHandle(own("value", value));
}

export function bind_get_named_parameter(bind_info: TableFunctionBindInfo, name: string): Value | null {
  const ptr = unwrap(bind_info, "table function bind info");
  const value = duckdb.duckdb_bind_get_named_parameter(ptr, cstr(expectString(name))) as Pointer | null;
  // Null when no parameter with this name was supplied.
  return value === null ? null : asHandle(own("value", value));
}

export function bind_set_bind_data(bind_info: TableFunctionBindInfo, bind_data: object): void {
  const ptr = unwrap(bind_info, "table function bind info");
  shim.dbs_set_bind_data(ptr, CallKind.tableBind, storeUserData(bind_data));
}

export function bind_set_cardinality(bind_info: TableFunctionBindInfo, cardinality: number, is_exact: boolean): void {
  const ptr = unwrap(bind_info, "table function bind info");
  // Read as 64 bits, as the official binding does: an estimate can exceed 32.
  const estimate = BigInt.asUintN(64, int64FromNumber(cardinality));
  duckdb.duckdb_bind_set_cardinality(ptr, estimate, expectBoolean(is_exact));
}

export function bind_set_error(bind_info: TableFunctionBindInfo, error: string): void {
  const ptr = unwrap(bind_info, "table function bind info");
  duckdb.duckdb_bind_set_error(ptr, cstr(expectString(error)));
}

// --- init ---------------------------------------------------------------------------------------

export function init_get_extra_info(init_info: TableFunctionInitInfo): object | undefined {
  return extraInfoOf(init_info, "table function init info");
}

export function init_get_bind_data(init_info: TableFunctionInitInfo): object | undefined {
  const ptr = unwrap(init_info, "table function init info");
  // Init and local init read bind data the same way.
  return userDataOf(shim.dbs_get_bind_data(ptr, CallKind.tableInit)) as object | undefined;
}

export function init_set_init_data(init_info: TableFunctionInitInfo, init_data: object): void {
  const ptr = unwrap(init_info, "table function init info");
  shim.dbs_set_init_data(ptr, storeUserData(init_data));
}

export function init_get_column_count(init_info: TableFunctionInitInfo): number {
  return Number(duckdb.duckdb_init_get_column_count(unwrap(init_info, "table function init info")));
}

export function init_get_column_index(init_info: TableFunctionInitInfo, column_index: number): number {
  const ptr = unwrap(init_info, "table function init info");
  return Number(duckdb.duckdb_init_get_column_index(ptr, uint32FromNumber(column_index)));
}

export function init_set_max_threads(init_info: TableFunctionInitInfo, max_threads: number): void {
  const ptr = unwrap(init_info, "table function init info");
  duckdb.duckdb_init_set_max_threads(ptr, uint32FromNumber(max_threads));
}

export function init_set_error(init_info: TableFunctionInitInfo, error: string): void {
  const ptr = unwrap(init_info, "table function init info");
  duckdb.duckdb_init_set_error(ptr, cstr(expectString(error)));
}

// --- main ---------------------------------------------------------------------------------------

export function function_get_extra_info(function_info: TableFunctionInfo): object | undefined {
  return extraInfoOf(function_info, "table function info");
}

export function function_get_bind_data(function_info: TableFunctionInfo): object | undefined {
  const ptr = unwrap(function_info, "table function info");
  return userDataOf(shim.dbs_get_bind_data(ptr, CallKind.tableMain)) as object | undefined;
}

export function function_get_init_data(function_info: TableFunctionInfo): object | undefined {
  return userDataOf(shim.dbs_get_init_data(unwrap(function_info, "table function info"))) as object | undefined;
}

export function function_get_local_init_data(function_info: TableFunctionInfo): object | undefined {
  return userDataOf(shim.dbs_get_local_init_data(unwrap(function_info, "table function info"))) as object | undefined;
}

export function function_set_error(function_info: TableFunctionInfo, error: string): void {
  const ptr = unwrap(function_info, "table function info");
  duckdb.duckdb_function_set_error(ptr, cstr(expectString(error)));
}
