// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import type { DuckDBDataChunk } from "./DuckDBDataChunk";
import type { DuckDBValueConverter } from "./DuckDBValueConverter";

export function convertColumnsObjectFromChunks<T>(
  chunks: readonly DuckDBDataChunk[],
  columnNames: readonly string[],
  converter: DuckDBValueConverter<T>,
): Record<string, (T | null)[]> {
  const convertedColumnsObject: Record<string, (T | null)[]> = {};
  for (const columnName of columnNames) {
    convertedColumnsObject[columnName] = [];
  }
  if (chunks.length === 0) {
    return convertedColumnsObject;
  }
  const columnCount = chunks[0].columnCount;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      chunks[chunkIndex].visitColumnValues(columnIndex, (value, _rowIndex, _columnIndex, type) =>
        convertedColumnsObject[columnNames[columnIndex]].push(converter(value, type, converter)),
      );
    }
  }
  return convertedColumnsObject;
}
