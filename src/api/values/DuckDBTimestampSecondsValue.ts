// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb, { type TimestampSeconds } from "../../bindings/index.ts";
import { getDuckDBTimestampStringFromSeconds } from "../conversion/dateTimeStringConversion";

export class DuckDBTimestampSecondsValue implements TimestampSeconds {
  public readonly seconds: bigint;

  public constructor(seconds: bigint) {
    this.seconds = seconds;
  }

  public get isFinite(): boolean {
    return duckdb.is_finite_timestamp_s(this);
  }

  public toString(): string {
    return getDuckDBTimestampStringFromSeconds(this.seconds);
  }

  public static readonly Epoch = new DuckDBTimestampSecondsValue(0n);
  public static readonly Max = new DuckDBTimestampSecondsValue(9223372036854n);
  public static readonly Min = new DuckDBTimestampSecondsValue(-9223372022400n); // from test_all_types() select epoch(timestamp_s)::bigint;
  public static readonly PosInf = new DuckDBTimestampSecondsValue(2n ** 63n - 1n);
  public static readonly NegInf = new DuckDBTimestampSecondsValue(-(2n ** 63n - 1n));
}

export function timestampSecondsValue(seconds: bigint): DuckDBTimestampSecondsValue {
  return new DuckDBTimestampSecondsValue(seconds);
}
