// Data chunk functions of the @duckdb/node-bindings contract. Semantics and
// error text follow the official binding (bindings/src/duckdb_node_bindings.cpp
// at the fork tag).
import type { Pointer } from "bun:ffi";
import type { DataChunk, LogicalType, Vector } from "../generated/contract.ts";
import { expectArray, throwIndexOutOfRange, uint32FromNumber } from "../runtime/convert.ts";
import { type Handle, handleOf, unwrap } from "../runtime/handle.ts";
import { borrow, own } from "../runtime/kinds.ts";
import { duckdb } from "../runtime/native.ts";
import { derived } from "../runtime/scope.ts";

function asHandle<T>(handle: Handle): T {
  return handle as unknown as T;
}

export function create_data_chunk(logical_types: readonly LogicalType[]): DataChunk {
  const array = expectArray(logical_types);
  const count = array.length;
  // duckdb_create_data_chunk needs a valid array pointer even for zero columns.
  const types = new BigUint64Array(Math.max(count, 1));
  for (let i = 0; i < count; i++) types[i] = BigInt(unwrap(array[i], "logical type") ?? 0);
  const chunk = duckdb.duckdb_create_data_chunk(types, count) as Pointer | null;
  // DuckDB returns null for a column type it will not accept (ANY, for one)
  // rather than reporting the refusal.
  if (chunk === null) {
    throw new Error("Failed to create data chunk. One or more column types are not supported.");
  }
  return asHandle(own("data chunk", chunk));
}

export function data_chunk_reset(chunk: DataChunk): void {
  duckdb.duckdb_data_chunk_reset(unwrap(chunk, "data chunk"));
}

export function data_chunk_get_column_count(chunk: DataChunk): number {
  return Number(duckdb.duckdb_data_chunk_get_column_count(unwrap(chunk, "data chunk")));
}

export function data_chunk_get_vector(chunk: DataChunk, column_index: number): Vector {
  const handle = handleOf(chunk, "data chunk");
  const ptr = handle.ptr;
  const index = uint32FromNumber(column_index);
  const vector = duckdb.duckdb_data_chunk_get_vector(ptr, index) as Pointer | null;
  if (vector === null) {
    throwIndexOutOfRange(index, Number(duckdb.duckdb_data_chunk_get_column_count(ptr)), "column");
  }
  // The vector belongs to the chunk, which the handle keeps alive.
  return asHandle(derived(handle, borrow("vector", vector, handle)));
}

export function data_chunk_get_size(chunk: DataChunk): number {
  return Number(duckdb.duckdb_data_chunk_get_size(unwrap(chunk, "data chunk")));
}

export function data_chunk_set_size(chunk: DataChunk, size: number): void {
  const ptr = unwrap(chunk, "data chunk");
  duckdb.duckdb_data_chunk_set_size(ptr, uint32FromNumber(size));
}
