// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { displayStringForDuckDBValue } from "../conversion/displayStringForDuckDBValue";
import type { DuckDBValue } from "./DuckDBValue";

/**
 * A value of a tuple type: an unnamed STRUCT, such as `(1, 'a')` or
 * `row(1, 'a')`. Its items are in entry order.
 */
export class DuckDBTupleValue {
  public readonly items: readonly DuckDBValue[];

  public constructor(items: readonly DuckDBValue[]) {
    this.items = items;
  }

  public toString(): string {
    return `(${this.items.map(displayStringForDuckDBValue).join(", ")})`;
  }
}

export function tupleValue(items: readonly DuckDBValue[]): DuckDBTupleValue {
  return new DuckDBTupleValue(items);
}
