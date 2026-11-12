// Scalar functions of the new bindings (src/bindings/api/scalar-function.ts):
// callbacks DuckDB makes from its own worker threads, errors thrown by a
// callback, and borrowed handles that die when the callback returns.

import { toArrayBuffer } from "bun:ffi";
import { afterAll, beforeAll, expect, test } from "bun:test";
import duckdb, {
  type Connection,
  type Database,
  type DataChunk,
  type ScalarFunctionInfo,
  Type,
  type Vector,
} from "../../src/bindings/index.ts";
import { shim } from "../../src/bindings/runtime/native.ts";

let database: Database;
let connection: Connection;

beforeAll(async () => {
  const config = duckdb.create_config();
  duckdb.set_config(config, "threads", "4");
  database = await duckdb.open(":memory:", config);
  connection = await duckdb.connect(database);
});

afterAll(() => {
  duckdb.disconnect_sync(connection);
  duckdb.close_sync(database);
});

function counters(): bigint[] {
  return [...new BigUint64Array(toArrayBuffer(shim.dbs_counters() as never, 0, 64))];
}

const BIGINT = () => duckdb.create_logical_type(Type.BIGINT);

function bigintFunction(name: string, main: (info: ScalarFunctionInfo, input: DataChunk, output: Vector) => void) {
  const scalar_function = duckdb.create_scalar_function();
  duckdb.scalar_function_set_name(scalar_function, name);
  duckdb.scalar_function_add_parameter(scalar_function, BIGINT());
  duckdb.scalar_function_set_return_type(scalar_function, BIGINT());
  duckdb.scalar_function_set_function(scalar_function, main);
  return scalar_function;
}

async function single(sql: string): Promise<bigint> {
  const result = await duckdb.query(connection, sql);
  const chunk = await duckdb.fetch_chunk(result);
  return new DataView(
    duckdb.vector_get_data(duckdb.data_chunk_get_vector(chunk as DataChunk, 0), 8).buffer,
  ).getBigInt64(0, true);
}

test("DuckDB worker threads call the main function, and each result lands in its row", async () => {
  await duckdb.query(connection, "CREATE TABLE numbers AS SELECT i FROM range(1000000) r(i)");
  let calls = 0;
  const scalar_function = bigintFunction("times_two", (info, input, output) => {
    calls++;
    const extra = duckdb.scalar_function_get_extra_info(info) as { factor: bigint };
    const rows = duckdb.data_chunk_get_size(input);
    const source = duckdb.vector_get_data(duckdb.data_chunk_get_vector(input, 0), rows * 8);
    const values = new BigInt64Array(source.buffer, 0, rows).map((value) => value * extra.factor);
    duckdb.copy_data_to_vector(output, 0, values.buffer, 0, rows * 8);
  });
  duckdb.scalar_function_set_volatile(scalar_function);
  duckdb.scalar_function_set_extra_info(scalar_function, { factor: 2n });
  duckdb.register_scalar_function(connection, scalar_function);
  duckdb.destroy_scalar_function_sync(scalar_function);

  const before = counters();
  expect(await single("SELECT sum(times_two(i))::BIGINT FROM numbers")).toBe(999999000000n);
  const after = counters();
  expect(calls).toBeGreaterThan(400);
  // Every call came from a DuckDB thread through the posted path, none inline.
  expect(after[4] - before[4]).toBe(BigInt(calls));
  expect(after[5] - before[5]).toBe(BigInt(calls));
  expect(after[6] - before[6]).toBe(0n);
});

test("init runs once per DuckDB thread and its state reaches that thread's calls", async () => {
  let inits = 0;
  const states = new Set<object>();
  const scalar_function = bigintFunction("with_state", (info, input, output) => {
    const state = duckdb.scalar_function_get_state(info) as { id: number };
    states.add(state);
    const rows = duckdb.data_chunk_get_size(input);
    duckdb.copy_data_to_vector(output, 0, new BigInt64Array(rows).fill(1n).buffer, 0, rows * 8);
  });
  duckdb.scalar_function_set_init(scalar_function, (info) => {
    inits++;
    duckdb.scalar_function_init_set_state(info, { id: inits });
  });
  duckdb.scalar_function_set_volatile(scalar_function);
  duckdb.register_scalar_function(connection, scalar_function);
  expect(await single("SELECT sum(with_state(i))::BIGINT FROM numbers")).toBe(1000000n);
  expect(inits).toBe(4);
  expect(states.size).toBe(4);
});

test("a thrown error becomes the query's error, whatever was thrown", async () => {
  const throwsError = bigintFunction("throws_error", () => {
    throw new Error("my scalar error");
  });
  duckdb.register_scalar_function(connection, throwsError);
  await expect(duckdb.query(connection, "SELECT throws_error(1)")).rejects.toThrow("my scalar error");

  const throwsString = bigintFunction("throws_string", () => {
    throw "a plain string";
  });
  duckdb.register_scalar_function(connection, throwsString);
  await expect(duckdb.query(connection, "SELECT throws_string(1)")).rejects.toThrow("a plain string");

  const bindThrows = bigintFunction("bind_throws", () => {});
  duckdb.scalar_function_set_bind(bindThrows, () => {
    throw new Error("my bind error");
  });
  duckdb.register_scalar_function(connection, bindThrows);
  await expect(duckdb.query(connection, "SELECT bind_throws(1)")).rejects.toThrow("my bind error");
});

test("handles a callback received die when it returns, and copies outlive them", async () => {
  let saved:
    | { info: ScalarFunctionInfo; input: DataChunk; output: Vector; vector: Vector; data: Uint8Array }
    | undefined;
  const scalar_function = bigintFunction("keeps_handles", (info, input, output) => {
    const vector = duckdb.data_chunk_get_vector(input, 0);
    const data = duckdb.vector_get_data(vector, 8);
    expect(data.byteLength).toBe(8);
    saved ??= { info, input, output, vector, data };
    const rows = duckdb.data_chunk_get_size(input);
    duckdb.copy_data_to_vector(output, 0, new BigInt64Array(rows).buffer, 0, rows * 8);
  });
  duckdb.register_scalar_function(connection, scalar_function);
  await duckdb.query(connection, "SELECT keeps_handles(1)");
  if (!saved) throw new Error("the function never ran");
  const { info, input, output, vector, data } = saved;
  expect(() => duckdb.scalar_function_get_extra_info(info)).toThrow(new Error("Invalid scalar function info argument"));
  expect(() => duckdb.data_chunk_get_size(input)).toThrow(new Error("Invalid data chunk argument"));
  expect(() => duckdb.vector_get_data(output, 8)).toThrow(new Error("Invalid vector argument"));
  expect(() => duckdb.vector_get_data(vector, 8)).toThrow(new Error("Invalid vector argument"));
  expect(data.byteLength).toBe(8);
  expect(() => duckdb.get_data_from_pointer(data.buffer as ArrayBuffer, 0, 1)).toThrow(
    new Error("Invalid vector argument"),
  );
});

test("registration needs a main function, and setters check their arguments", () => {
  const scalar_function = duckdb.create_scalar_function();
  duckdb.scalar_function_set_name(scalar_function, "no_main");
  duckdb.scalar_function_set_return_type(scalar_function, BIGINT());
  expect(() => duckdb.register_scalar_function(connection, scalar_function)).toThrow(
    new Error("Failed to register scalar function"),
  );
  expect(() => duckdb.scalar_function_set_function(scalar_function, 1 as never)).toThrow(
    new Error("A function was expected"),
  );
  expect(() => duckdb.scalar_function_set_name(connection as never, "x")).toThrow(
    new Error("Invalid scalar function argument"),
  );
  duckdb.destroy_scalar_function_sync(scalar_function);
  duckdb.destroy_scalar_function_sync(scalar_function);
  expect(() => duckdb.register_scalar_function(connection, scalar_function)).toThrow(
    new Error("Failed to register scalar function"),
  );
});
