// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { assert, beforeAll, describe, test } from "../vitest-shim.ts";
import { setDefaultTimezone, withConnection } from "./util/testHelpers";

describe("getTableNames", () => {
  beforeAll(setDefaultTimezone);

  test("getTableNames (single, qualified)", async () => {
    await withConnection(async (connection) => {
      assert.deepEqual(connection.getTableNames("from memory.main.t1", true), ["memory.main.t1"]);
    });
  });
  test("getTableNames (single, unqualified)", async () => {
    await withConnection(async (connection) => {
      assert.deepEqual(connection.getTableNames("from memory.main.t1", false), ["t1"]);
    });
  });
  test("getTableNames (multiple, qualified)", async () => {
    await withConnection(async (connection) => {
      assert.deepEqual(connection.getTableNames("from memory.main.t1, memory.main.t2, memory.main.t1", true), [
        "memory.main.t1",
        "memory.main.t2",
      ]);
    });
  });
  test("getTableNames (multiple, unqualified)", async () => {
    await withConnection(async (connection) => {
      assert.deepEqual(connection.getTableNames("from memory.main.t1, memory.main.t2, memory.main.t1", false), [
        "t1",
        "t2",
      ]);
    });
  });
  test("getTableNames (none))", async () => {
    await withConnection(async (connection) => {
      assert.deepEqual(connection.getTableNames("select 1", true), []);
    });
  });
});
