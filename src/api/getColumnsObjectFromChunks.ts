// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import type { DuckDBDataChunk } from "./DuckDBDataChunk";
import type { DuckDBValue } from "./values";

export function getColumnsObjectFromChunks(
  chunks: readonly DuckDBDataChunk[],
  columnNames: readonly string[],
): Record<string, DuckDBValue[]> {
  const columnsObject: Record<string, DuckDBValue[]> = {};
  for (const columnName of columnNames) {
    columnsObject[columnName] = [];
  }
  for (const chunk of chunks) {
    chunk.appendToColumnsObject(columnNames, columnsObject);
  }
  return columnsObject;
}
