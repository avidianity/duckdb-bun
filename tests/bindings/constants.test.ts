// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../../src/bindings/index.ts";
import { expect, suite, test } from "../vitest-shim.ts";

suite("constants", () => {
  test("sizeof_bool", () => {
    expect(duckdb.sizeof_bool).toBe(1);
  });
  test("library_version", () => {
    expect(duckdb.library_version()).toBe("v2.0.0");
  });
  test("vector_size", () => {
    expect(duckdb.vector_size()).toBe(2048);
  });
});
