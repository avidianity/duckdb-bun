// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import type { DuckDBDataChunk } from "./DuckDBDataChunk";
import type { DuckDBValueConverter } from "./DuckDBValueConverter";

export function convertColumnsFromChunks<T>(
  chunks: readonly DuckDBDataChunk[],
  columnCount: number,
  converter: DuckDBValueConverter<T>,
): (T | null)[][] {
  if (chunks.length === 0) {
    return Array.from({ length: columnCount }, () => []);
  }
  const convertedColumns = chunks[0].convertColumns(converter);
  for (let chunkIndex = 1; chunkIndex < chunks.length; chunkIndex++) {
    for (let columnIndex = 0; columnIndex < convertedColumns.length; columnIndex++) {
      const chunk = chunks[chunkIndex];
      chunk.visitColumnValues(columnIndex, (value, _rowIndex, _columnIndex, type) =>
        convertedColumns[columnIndex].push(converter(value, type, converter)),
      );
    }
  }
  return convertedColumns;
}
