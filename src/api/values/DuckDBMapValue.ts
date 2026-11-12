// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { displayStringForDuckDBValue } from "../conversion/displayStringForDuckDBValue";
import type { DuckDBValue } from "./DuckDBValue";

export interface DuckDBMapEntry {
  key: DuckDBValue;
  value: DuckDBValue;
}

export class DuckDBMapValue {
  public readonly entries: DuckDBMapEntry[];

  public constructor(entries: DuckDBMapEntry[]) {
    this.entries = entries;
  }

  public toString(): string {
    return `{${this.entries
      .map(({ key, value }) => `${displayStringForDuckDBValue(key)}: ${displayStringForDuckDBValue(value)}`)
      .join(", ")}}`;
  }
}

export function mapValue(entries: DuckDBMapEntry[]): DuckDBMapValue {
  return new DuckDBMapValue(entries);
}
