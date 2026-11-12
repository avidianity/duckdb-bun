// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../../src/bindings/index.ts";
import { expect, suite, test } from "../vitest-shim.ts";

suite("instance_cache", () => {
  test("create", async () => {
    const cache = duckdb.create_instance_cache();
    expect(cache).toBeTruthy();
  });
  test("empty path", async () => {
    const cache = duckdb.create_instance_cache();
    const db1 = await duckdb.get_or_create_from_cache(cache, "");
    expect(db1).toBeTruthy();
    const db2 = await duckdb.get_or_create_from_cache(cache, "");
    expect(db2).toStrictEqual(db1);
  });
  test("memory path", async () => {
    const cache = duckdb.create_instance_cache();
    const db1 = await duckdb.get_or_create_from_cache(cache, ":memory:");
    expect(db1).toBeTruthy();
    const db2 = await duckdb.get_or_create_from_cache(cache, ":memory:");
    expect(db2).toStrictEqual(db1);
  });
});
