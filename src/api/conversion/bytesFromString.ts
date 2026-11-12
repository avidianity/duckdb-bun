// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

const textEncoder = new TextEncoder();

export function bytesFromString(str: string): Uint8Array {
  return textEncoder.encode(str);
}
