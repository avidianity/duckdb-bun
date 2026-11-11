// One constructor per handle kind, pairing each owned pointer with the C
// function that frees it, as the official binding's externals.h does.
import type { Pointer } from "bun:ffi";
import { borrowed, type Handle, type Kind, owned } from "./handle.ts";
import { slot } from "./marshal.ts";
import { duckdb } from "./native.ts";

/** Calls a `duckdb_destroy_x(T *handle)` style function with the address of `ptr`. */
function viaSlot(destroy: (address: BigUint64Array) => void): (ptr: Pointer) => void {
  return (ptr) => destroy(slot(ptr));
}

const DESTROY = {
  appender: viaSlot((a) => duckdb.duckdb_appender_destroy(a)),
  catalog: viaSlot((a) => duckdb.duckdb_destroy_catalog(a)),
  "catalog entry": viaSlot((a) => duckdb.duckdb_destroy_catalog_entry(a)),
  "client context": viaSlot((a) => duckdb.duckdb_destroy_client_context(a)),
  config: viaSlot((a) => duckdb.duckdb_destroy_config(a)),
  connection: viaSlot((a) => duckdb.duckdb_disconnect(a)),
  "data chunk": viaSlot((a) => duckdb.duckdb_destroy_data_chunk(a)),
  database: viaSlot((a) => duckdb.duckdb_close(a)),
  "extracted statements": viaSlot((a) => duckdb.duckdb_destroy_extracted(a)),
  "instance cache": viaSlot((a) => duckdb.duckdb_destroy_instance_cache(a)),
  "logical type": viaSlot((a) => duckdb.duckdb_destroy_logical_type(a)),
  "pending result": viaSlot((a) => duckdb.duckdb_destroy_pending(a)),
  "prepared statement": viaSlot((a) => duckdb.duckdb_destroy_prepare(a)),
  // A result is a `duckdb_result *` the shim allocated with duckdb_malloc.
  result: (ptr: Pointer) => {
    duckdb.duckdb_destroy_result(ptr);
    duckdb.duckdb_free(ptr);
  },
  "scalar function": viaSlot((a) => duckdb.duckdb_destroy_scalar_function(a)),
  "table function": viaSlot((a) => duckdb.duckdb_destroy_table_function(a)),
  value: viaSlot((a) => duckdb.duckdb_destroy_value(a)),
  vector: viaSlot((a) => duckdb.duckdb_destroy_vector(a)),
} as const satisfies Partial<Record<Kind, (ptr: Pointer) => void>>;

export type OwnedKind = keyof typeof DESTROY;

/** Wraps a pointer the caller now owns; it is freed when collected or explicitly destroyed. */
export function own<K extends OwnedKind>(kind: K, ptr: Pointer): Handle<K> {
  return owned(kind, ptr, DESTROY[kind]);
}

/** Wraps a pointer owned elsewhere: a data chunk's vector, a callback's info, a chunk passed to a callback. */
export function borrow<K extends Kind>(kind: K, ptr: Pointer | null, owner?: object): Handle<K> {
  return borrowed(kind, ptr, owner);
}

/** The destroy function for a kind, for the explicit `*_sync` destroy entry points. */
export function destroyerOf(kind: OwnedKind): (ptr: Pointer) => void {
  return DESTROY[kind];
}
