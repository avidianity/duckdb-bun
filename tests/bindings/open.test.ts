// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../../src/bindings/index.ts";
import { expect, suite, test } from "../vitest-shim.ts";

suite("open", () => {
  test("no args", async () => {
    const db = await duckdb.open();
    try {
      expect(db).toBeTruthy();
    } finally {
      duckdb.close_sync(db);
    }
  });
  test("memory arg", async () => {
    const db = await duckdb.open(":memory:");
    try {
      expect(db).toBeTruthy();
    } finally {
      duckdb.close_sync(db);
    }
  });
  test("with config", async () => {
    const config = duckdb.create_config();
    duckdb.set_config(config, "custom_user_agent", "my_user_agent");
    const db = await duckdb.open(":memory:", config);
    try {
      expect(db).toBeTruthy();
    } finally {
      duckdb.close_sync(db);
    }
  });
  test("close", async () => {
    const db = await duckdb.open();
    try {
      expect(db).toBeTruthy();
      duckdb.close_sync(db);
      await expect(async () => await duckdb.connect(db)).rejects.toStrictEqual(
        new Error("Failed to connect: instance closed"),
      );
      // double-close should be a no-op
      duckdb.close_sync(db);
    } finally {
      duckdb.close_sync(db);
    }
  });
});
