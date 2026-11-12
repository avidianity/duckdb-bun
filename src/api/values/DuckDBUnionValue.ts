// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import type { DuckDBValue } from "./DuckDBValue";

export class DuckDBUnionValue {
  public readonly tag: string;
  public readonly value: DuckDBValue;

  public constructor(tag: string, value: DuckDBValue) {
    this.tag = tag;
    this.value = value;
  }

  public toString(): string {
    if (this.value == null) {
      return "NULL";
    }
    return this.value.toString();
  }
}

export function unionValue(tag: string, value: DuckDBValue): DuckDBUnionValue {
  return new DuckDBUnionValue(tag, value);
}
