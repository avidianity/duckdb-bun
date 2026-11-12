// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { quotedString } from "../sql";
import type { DuckDBValue } from "../values";

export function displayStringForDuckDBValue(value: DuckDBValue): string {
  if (value == null) {
    return "NULL";
  }
  if (typeof value === "string") {
    return quotedString(value);
  }
  return value.toString();
}
