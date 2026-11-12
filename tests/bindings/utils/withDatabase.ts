// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../../../src/bindings/index.ts";

export async function withDatabase(
  { path, config }: { path?: string; config?: duckdb.Config },
  fn: (db: duckdb.Database) => Promise<void>,
): Promise<void> {
  const db = await duckdb.open(path, config);
  try {
    await fn(db);
  } finally {
    duckdb.close_sync(db);
  }
}
