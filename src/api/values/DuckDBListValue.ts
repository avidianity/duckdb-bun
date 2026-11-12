// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { displayStringForDuckDBValue } from "../conversion/displayStringForDuckDBValue";
import type { DuckDBValue } from "./DuckDBValue";

export class DuckDBListValue {
  public readonly items: readonly DuckDBValue[];

  public constructor(items: readonly DuckDBValue[]) {
    this.items = items;
  }

  public toString(): string {
    return `[${this.items.map(displayStringForDuckDBValue).join(", ")}]`;
  }
}

export function listValue(items: readonly DuckDBValue[]): DuckDBListValue {
  return new DuckDBListValue(items);
}
