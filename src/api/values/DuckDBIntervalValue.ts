// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import type { Interval } from "../../bindings/index.ts";
import { getDuckDBIntervalString } from "../conversion/dateTimeStringConversion";

export class DuckDBIntervalValue implements Interval {
  public readonly months: number;
  public readonly days: number;
  public readonly micros: bigint;

  public constructor(months: number, days: number, micros: bigint) {
    this.months = months;
    this.days = days;
    this.micros = micros;
  }

  public toString(): string {
    return getDuckDBIntervalString(this.months, this.days, this.micros);
  }
}

export function intervalValue(months: number, days: number, micros: bigint): DuckDBIntervalValue {
  return new DuckDBIntervalValue(months, days, micros);
}
