// One constructor per handle kind. The shim frees each owned pointer with the C
// function the official binding's externals.h pairs with its kind, and records it
// in this JS thread's context, so a Worker that ends without running script
// still frees it (native/ABI.md, "Handle ownership").
import type { Pointer } from "bun:ffi";
import "./dispatch.ts"; // Opens this JS thread's shim context before the first handle.
import { borrowed, type Handle, type Kind, owned } from "./handle.ts";
import { shim } from "./native.ts";

/** Handle kind codes from native/ABI.md. */
const KIND_CODE = {
  appender: 1,
  catalog: 2,
  "catalog entry": 3,
  "client context": 4,
  config: 5,
  connection: 6,
  "data chunk": 7,
  database: 8,
  "extracted statements": 9,
  "instance cache": 10,
  "logical type": 11,
  "pending result": 12,
  "prepared statement": 13,
  // A `duckdb_result *` the shim allocated with duckdb_malloc.
  result: 14,
  "scalar function": 15,
  "table function": 16,
  value: 17,
  vector: 18,
} as const satisfies Partial<Record<Kind, number>>;

export type OwnedKind = keyof typeof KIND_CODE;

const DESTROY = Object.fromEntries(
  Object.entries(KIND_CODE).map(([kind, code]) => [kind, (ptr: Pointer) => shim.dbs_destroy(code, ptr)]),
) as Record<OwnedKind, (ptr: Pointer) => void>;

/** Wraps a pointer the caller now owns; it is freed when collected or explicitly destroyed. */
export function own<K extends OwnedKind>(kind: K, ptr: Pointer): Handle<K> {
  shim.dbs_own(KIND_CODE[kind], ptr);
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
