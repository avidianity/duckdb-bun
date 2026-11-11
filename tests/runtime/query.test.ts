// The query, prepared statement, bind, pending and result families of the new
// bindings (src/bindings/api/query.ts), through the contract entry points the
// vendored suites cannot reach until the value and chunk families land.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as db from "../../src/bindings/api/database.ts";
import * as q from "../../src/bindings/api/query.ts";
import { StatementType, Type } from "../../src/bindings/generated/contract.ts";

let database: Awaited<ReturnType<typeof db.open>>;
let connection: Awaited<ReturnType<typeof db.connect>>;

beforeAll(async () => {
  database = await db.open();
  connection = await db.connect(database);
});

afterAll(() => {
  db.disconnect_sync(connection);
  db.close_sync(database);
});

test("query returns column metadata and official out-of-range errors", async () => {
  const result = await q.query(connection, "SELECT 42::INTEGER AS answer, 'x' AS name");
  expect(q.column_count(result)).toBe(2);
  expect(q.column_name(result, 1)).toBe("name");
  expect(q.column_type(result, 0)).toBe(Type.INTEGER);
  expect(q.result_statement_type(result)).toBe(StatementType.SELECT);
  expect(q.result_is_streaming(result)).toBe(false);
  expect(() => q.column_name(result, 5)).toThrow(new RangeError("column index 5 is out of range (count: 2)"));
  expect(await q.fetch_chunk(result)).not.toBeNull();
  expect(await q.fetch_chunk(result)).toBeNull();
  q.destroy_result_sync(result);
  q.destroy_result_sync(result);
  expect(() => q.column_count(result)).toThrow(new Error("Result destroyed"));
});

test("query errors carry DuckDB's text, and a disconnected connection the official one", async () => {
  await expect(q.query(connection, "SELECT * FROM missing_table")).rejects.toThrow(
    /^Catalog Error: Table with name missing_table does not exist/,
  );
  const other = await db.connect(database);
  db.disconnect_sync(other);
  await expect(q.query(other, "SELECT 1")).rejects.toStrictEqual(new Error("Failed to query: connection disconnected"));
});

test("prepare, bind and execute, with official bind errors", async () => {
  const prepared = await q.prepare(connection, "SELECT $a::BIGINT + 1 AS b, $s AS s");
  expect(q.nparams(prepared)).toBe(2);
  expect(q.parameter_name(prepared, 1)).toBe("a");
  expect(q.bind_parameter_index(prepared, "s")).toBe(2);
  q.bind_int64(prepared, 1, 41n);
  q.bind_varchar(prepared, 2, "héllo");
  expect(q.param_type(prepared, 1)).toBe(Type.BIGINT);
  expect(() => q.param_type(prepared, 0)).toThrow(new RangeError("parameter index 0 is out of range (count: 2)"));
  expect(() => q.bind_int64(prepared, 1, 1n << 64n)).toThrow(new Error("bigint out of int64 range"));
  expect(() => q.bind_int32(prepared, 9, 1)).toThrow(/^Failed to bind int32: /);
  const result = await q.execute_prepared(prepared);
  expect(q.row_count(result)).toBe(1);
  expect(q.result_chunk_count(result)).toBe(1);
  q.result_get_chunk(result, 0);
  q.destroy_result_sync(result);
  q.destroy_prepare_sync(prepared);
  await expect(q.execute_prepared(prepared)).rejects.toStrictEqual(new Error("Failed to execute prepared statement"));
});

test("pending results run tasks and execute on a native thread", async () => {
  const prepared = await q.prepare(connection, "SELECT sum(range) FROM range(100000)");
  const pending = q.pending_prepared(prepared);
  q.pending_execute_check_state(pending);
  const result = await q.execute_pending(pending);
  expect(q.column_count(result)).toBe(1);
  q.destroy_pending_sync(pending);
  expect(() => q.pending_error(pending)).toThrow(new Error("Pending result destroyed"));
  q.destroy_result_sync(result);
});

test("extracted statements prepare one by one", async () => {
  const { extracted_statements, statement_count } = await q.extract_statements(
    connection,
    "CREATE TABLE t (i INTEGER); INSERT INTO t VALUES (1), (2)",
  );
  expect(statement_count).toBe(2);
  for (let i = 0; i < statement_count; i++) {
    const prepared = await q.prepare_extracted_statement(connection, extracted_statements, i);
    const result = await q.execute_prepared(prepared);
    if (i === 1) expect(q.rows_changed(result)).toBe(2);
  }
  const bad = await q.extract_statements(connection, "SELEC 1");
  expect(bad.statement_count).toBe(0);
  expect(q.extract_statements_error(bad.extracted_statements)).toMatch(/^Parser Error: syntax error/);
});
