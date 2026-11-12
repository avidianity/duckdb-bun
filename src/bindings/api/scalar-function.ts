// Scalar function functions of the @duckdb/node-bindings contract. Semantics
// and error text follow the official binding (bindings/src/duckdb_node_bindings.cpp
// and scalar_function_helpers.h at the vendored tag).
//
// The callbacks, extra info, bind data and state are JavaScript values; DuckDB
// holds only ids (native/ABI.md, "Function callbacks"). A function's callbacks
// and extra info live in one state object per ScalarFunction, which the call
// handler for its id closes over, so DuckDB's copies of a registered function
// keep using it after destroy_scalar_function_sync. DuckDB has one extra info
// slot, so the shim's trampolines are set at registration, once the callbacks
// are known; the official binding sets each trampoline as its callback is set,
// with the same effect on what DuckDB registers.
import type { Pointer } from "bun:ffi";
import type {
  ClientContext,
  Connection,
  DataChunk,
  LogicalType,
  ScalarFunction,
  ScalarFunctionBindFunction,
  ScalarFunctionBindInfo,
  ScalarFunctionInfo,
  ScalarFunctionInitFunction,
  ScalarFunctionInitInfo,
  ScalarFunctionMainFunction,
  Vector,
} from "../generated/contract.ts";
import { expectFunction, expectReferenceable, expectString } from "../runtime/convert.ts";
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

interface ScalarFunctionState {
  extraInfo: unknown;
  bind?: ScalarFunctionBindFunction;
  init?: ScalarFunctionInitFunction;
  main?: ScalarFunctionMainFunction;
  /** The trampolines last given to DuckDB, or undefined before the first registration. */
  applied?: { bind: boolean; init: boolean };
}

const states = new WeakMap<object, ScalarFunctionState>();

/** The function state behind a callback's info handle. */
const infoStates = new WeakMap<object, ScalarFunctionState>();

function stateOf(scalar_function: ScalarFunction): { ptr: Pointer | null; state: ScalarFunctionState } {
  const ptr = unwrap(scalar_function, "scalar function");
  return { ptr, state: states.get(scalar_function as object) as ScalarFunctionState };
}

function infoState(info: unknown, kind: Kind): { ptr: Pointer | null; state: ScalarFunctionState } {
  const ptr = unwrap(info, kind);
  return { ptr, state: infoStates.get(info as object) as ScalarFunctionState };
}

// --- calls from DuckDB ------------------------------------------------------------------------

function errorSetter(set: (info: Pointer, message: Buffer) => void, info: Pointer): (message: string) => void {
  return (message) => set(info, cstr(message));
}

function callInfo<K extends Kind>(scope: CallbackScope, kind: K, ptr: Pointer, state: ScalarFunctionState): Handle<K> {
  const info = scope.adopt(borrow(kind, ptr));
  infoStates.set(info, state);
  return info;
}

function handlerFor(state: ScalarFunctionState) {
  return (kind: number, info: Pointer, input: Pointer | null, output: Pointer | null): void => {
    const scope = new CallbackScope();
    switch (kind) {
      case CallKind.scalarBind: {
        const handle = callInfo(scope, "scalar function bind info", info, state);
        runInScope(
          scope,
          () => state.bind?.(asHandle(handle)),
          errorSetter((i, m) => duckdb.duckdb_scalar_function_bind_set_error(i, m), info),
        );
        return;
      }
      case CallKind.scalarInit: {
        const handle = callInfo(scope, "scalar function init info", info, state);
        runInScope(
          scope,
          () => state.init?.(asHandle(handle)),
          errorSetter((i, m) => duckdb.duckdb_scalar_function_init_set_error(i, m), info),
        );
        return;
      }
      case CallKind.scalarMain: {
        const handle = callInfo(scope, "scalar function info", info, state);
        const chunk = scope.adopt(borrow("data chunk", input));
        const vector = scope.adopt(borrow("vector", output));
        runInScope(
          scope,
          () => state.main?.(asHandle(handle), asHandle<DataChunk>(chunk), asHandle<Vector>(vector)),
          errorSetter((i, m) => duckdb.duckdb_scalar_function_set_error(i, m), info),
        );
        return;
      }
      default:
        scope.close();
    }
  };
}

/**
 * Gives DuckDB the shim's trampolines for the callbacks set so far, under a new
 * id, unless it already has exactly those. Without a main function nothing is
 * set, so DuckDB refuses the registration, as it does in the official binding.
 */
function applyCallbacks(ptr: Pointer, state: ScalarFunctionState): void {
  if (!state.main) return;
  const wanted = { bind: state.bind !== undefined, init: state.init !== undefined };
  const applied = state.applied;
  if (applied && applied.bind === wanted.bind && applied.init === wanted.init) return;
  const id = allocateId();
  setCallHandler(id, handlerFor(state));
  shim.dbs_scalar_function_set_callbacks(ptr, id, wanted.bind, wanted.init);
  state.applied = wanted;
}

// --- the function object ------------------------------------------------------------------------

export function create_scalar_function(): ScalarFunction {
  const handle = own("scalar function", duckdb.duckdb_create_scalar_function() as Pointer);
  states.set(handle, { extraInfo: undefined });
  return asHandle(handle);
}

export function destroy_scalar_function_sync(scalar_function: ScalarFunction): void {
  // A no-op once destroyed, as duckdb_destroy_scalar_function is.
  handleOf(scalar_function, "scalar function").requestDestroy();
}

export function scalar_function_set_name(scalar_function: ScalarFunction, name: string): void {
  const ptr = unwrap(scalar_function, "scalar function");
  duckdb.duckdb_scalar_function_set_name(ptr, cstr(expectString(name)));
}

export function scalar_function_set_varargs(scalar_function: ScalarFunction, logical_type: LogicalType): void {
  const ptr = unwrap(scalar_function, "scalar function");
  duckdb.duckdb_scalar_function_set_varargs(ptr, unwrap(logical_type, "logical type"));
}

export function scalar_function_set_special_handling(scalar_function: ScalarFunction): void {
  duckdb.duckdb_scalar_function_set_special_handling(unwrap(scalar_function, "scalar function"));
}

export function scalar_function_set_volatile(scalar_function: ScalarFunction): void {
  duckdb.duckdb_scalar_function_set_volatile(unwrap(scalar_function, "scalar function"));
}

export function scalar_function_add_parameter(scalar_function: ScalarFunction, logical_type: LogicalType): void {
  const ptr = unwrap(scalar_function, "scalar function");
  duckdb.duckdb_scalar_function_add_parameter(ptr, unwrap(logical_type, "logical type"));
}

export function scalar_function_set_return_type(scalar_function: ScalarFunction, logical_type: LogicalType): void {
  const ptr = unwrap(scalar_function, "scalar function");
  duckdb.duckdb_scalar_function_set_return_type(ptr, unwrap(logical_type, "logical type"));
}

export function scalar_function_set_extra_info(scalar_function: ScalarFunction, extra_info: object): void {
  const { state } = stateOf(scalar_function);
  state.extraInfo = expectReferenceable(extra_info);
}

export function scalar_function_set_bind(scalar_function: ScalarFunction, func: ScalarFunctionBindFunction): void {
  stateOf(scalar_function).state.bind = expectFunction(func);
}

export function scalar_function_set_init(scalar_function: ScalarFunction, func: ScalarFunctionInitFunction): void {
  stateOf(scalar_function).state.init = expectFunction(func);
}

export function scalar_function_set_function(scalar_function: ScalarFunction, func: ScalarFunctionMainFunction): void {
  stateOf(scalar_function).state.main = expectFunction(func);
}

export function register_scalar_function(connection: Connection, scalar_function: ScalarFunction): void {
  const connectionPtr = unwrap(connection, "connection");
  const { ptr, state } = stateOf(scalar_function);
  if (ptr !== null) applyCallbacks(ptr, state);
  record(RingOp.registerScalarFunction, ptr);
  if (duckdb.duckdb_register_scalar_function(connectionPtr, ptr)) {
    throw new Error("Failed to register scalar function");
  }
}

// --- bind ---------------------------------------------------------------------------------------

export function scalar_function_set_bind_data(info: ScalarFunctionBindInfo, bind_data: object): void {
  const ptr = unwrap(info, "scalar function bind info");
  shim.dbs_set_bind_data(ptr, CallKind.scalarBind, storeUserData(bind_data));
}

export function scalar_function_bind_set_error(bind_info: ScalarFunctionBindInfo, error: string): void {
  const ptr = unwrap(bind_info, "scalar function bind info");
  duckdb.duckdb_scalar_function_bind_set_error(ptr, cstr(expectString(error)));
}

export function scalar_function_bind_get_extra_info(bind_info: ScalarFunctionBindInfo): object | undefined {
  return infoState(bind_info, "scalar function bind info").state.extraInfo as object | undefined;
}

function clientContext(get: (out: BigUint64Array) => void): ClientContext {
  const out = slot();
  get(out);
  const context = slotValue(out);
  if (context === null) throw new Error("Failed to get client context");
  return asHandle(own("client context", context));
}

export function scalar_function_get_client_context(bind_info: ScalarFunctionBindInfo): ClientContext {
  const ptr = unwrap(bind_info, "scalar function bind info");
  return clientContext((out) => duckdb.duckdb_scalar_function_get_client_context(ptr, out));
}

// --- init ---------------------------------------------------------------------------------------

export function scalar_function_init_set_error(init_info: ScalarFunctionInitInfo, error: string): void {
  const ptr = unwrap(init_info, "scalar function init info");
  duckdb.duckdb_scalar_function_init_set_error(ptr, cstr(expectString(error)));
}

export function scalar_function_init_set_state(init_info: ScalarFunctionInitInfo, state: object): void {
  const ptr = unwrap(init_info, "scalar function init info");
  shim.dbs_scalar_init_set_state(ptr, storeUserData(state));
}

export function scalar_function_init_get_client_context(init_info: ScalarFunctionInitInfo): ClientContext {
  const ptr = unwrap(init_info, "scalar function init info");
  return clientContext((out) => duckdb.duckdb_scalar_function_init_get_client_context(ptr, out));
}

export function scalar_function_init_get_bind_data(init_info: ScalarFunctionInitInfo): object | undefined {
  const ptr = unwrap(init_info, "scalar function init info");
  return userDataOf(shim.dbs_get_bind_data(ptr, CallKind.scalarInit)) as object | undefined;
}

export function scalar_function_init_get_extra_info(init_info: ScalarFunctionInitInfo): object | undefined {
  return infoState(init_info, "scalar function init info").state.extraInfo as object | undefined;
}

// --- main ---------------------------------------------------------------------------------------

export function scalar_function_get_extra_info(function_info: ScalarFunctionInfo): object | undefined {
  return infoState(function_info, "scalar function info").state.extraInfo as object | undefined;
}

export function scalar_function_get_bind_data(function_info: ScalarFunctionInfo): object | undefined {
  const ptr = unwrap(function_info, "scalar function info");
  return userDataOf(shim.dbs_get_bind_data(ptr, CallKind.scalarMain)) as object | undefined;
}

export function scalar_function_set_error(function_info: ScalarFunctionInfo, error: string): void {
  const ptr = unwrap(function_info, "scalar function info");
  duckdb.duckdb_scalar_function_set_error(ptr, cstr(expectString(error)));
}

export function scalar_function_get_state(function_info: ScalarFunctionInfo): object | undefined {
  const ptr = unwrap(function_info, "scalar function info");
  return userDataOf(shim.dbs_scalar_get_state(ptr)) as object | undefined;
}
