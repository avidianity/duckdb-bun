// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import type { DuckDBDataChunk } from "./DuckDBDataChunk";
import type { DuckDBValue } from "./values";

export function getColumnsFromChunks(chunks: readonly DuckDBDataChunk[], columnCount: number): DuckDBValue[][] {
  const columns: DuckDBValue[][] = Array.from({ length: columnCount }, () => []);
  for (const chunk of chunks) {
    chunk.appendToColumns(columns);
  }
  return columns;
}
