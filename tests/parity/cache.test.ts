// Instance cache parity: DuckDBInstance.fromCache and DuckDBInstanceCache return
// working instances that share one database per path.
import { join } from "node:path";
import type { DuckDBInstance } from "@duckdb/node-api";
import { capture, parityFor } from "./harness.ts";

const parity = parityFor(import.meta.path);

async function rows(instance: DuckDBInstance, sql: string) {
  const connection = await instance.connect();
  try {
    return (await connection.runAndReadAll(sql)).getRowsJson();
  } finally {
    connection.closeSync();
  }
}

parity(
  "fromCache returns working instances that share a file database",
  async (api, { tmp }) => {
    const path = join(tmp, "cached.duckdb");
    const first = await api.DuckDBInstance.fromCache(path);
    const second = await api.DuckDBInstance.fromCache(path);
    await rows(first, "CREATE TABLE t AS SELECT 7 AS i");
    const seen = await rows(second, "SELECT i FROM t");
    const databases = await rows(second, "SELECT database_name, path FROM duckdb_databases() WHERE NOT internal");
    first.closeSync();
    const afterFirstClosed = await capture(() => rows(second, "SELECT count(*) AS n FROM t"));
    second.closeSync();
    return { sameObject: first === second, seen, databases, afterFirstClosed };
  },
  { official: "ok" },
);

parity(
  "fromCache with the same path and different options",
  async (api, { tmp }) => {
    const path = join(tmp, "options.duckdb");
    const first = await api.DuckDBInstance.fromCache(path, { threads: "1" });
    const conflicting = await capture(async () => {
      const second = await api.DuckDBInstance.fromCache(path, { threads: "2" });
      return rows(second, "SELECT current_setting('threads') AS threads");
    });
    first.closeSync();
    return conflicting;
  },
  { official: "ok" },
);

parity(
  "fromCache for in-memory databases",
  async (api) => {
    const first = await api.DuckDBInstance.fromCache(":memory:");
    const second = await api.DuckDBInstance.fromCache(":memory:");
    const defaultPath = await api.DuckDBInstance.fromCache();
    await rows(first, "CREATE TABLE t AS SELECT 1 AS i");
    const result = {
      second: await capture(() => rows(second, "SELECT i FROM t")),
      defaultPath: await capture(() => rows(defaultPath, "SELECT i FROM t")),
    };
    for (const instance of [first, second, defaultPath]) instance.closeSync();
    return result;
  },
  { official: "ok" },
);

parity(
  "a DuckDBInstanceCache of its own",
  async (api, { tmp }) => {
    const path = join(tmp, "own-cache.duckdb");
    const cache = new api.DuckDBInstanceCache();
    const first = await cache.getOrCreateInstance(path, { TimeZone: "UTC" });
    const second = await cache.getOrCreateInstance(path, { TimeZone: "UTC" });
    await rows(first, "CREATE TABLE t AS SELECT 'shared' AS s");
    const result = {
      seen: await rows(second, "SELECT s, current_setting('TimeZone') AS tz FROM t"),
      singletonIsNotOwn: api.DuckDBInstanceCache.singleton !== cache,
    };
    first.closeSync();
    second.closeSync();
    return result;
  },
  { official: "ok" },
);
