// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../../../src/bindings/index.ts";
import { withDatabase } from "./withDatabase";

export async function withConnection(
  fn: (connection: duckdb.Connection, db: duckdb.Database) => Promise<void>,
): Promise<void> {
  await withDatabase({}, async (db) => {
    const connection = await duckdb.connect(db);
    try {
      await fn(connection, db);
    } finally {
      duckdb.disconnect_sync(connection);
    }
  });
}
