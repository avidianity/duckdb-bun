// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../../src/bindings/index.ts";
import { expect, suite, test } from "../vitest-shim.ts";
import { withDatabase } from "./utils/withDatabase";

suite("errors", () => {
  test("wrong external type", async () => {
    await withDatabase({}, async (db) => {
      expect(() => duckdb.query(db as unknown as duckdb.Connection, "select 1")).toThrowError(
        /^Invalid connection argument$/,
      );
    });
  });
});
