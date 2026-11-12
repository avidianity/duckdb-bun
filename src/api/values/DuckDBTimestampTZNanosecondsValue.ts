// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb, { type TimestampNanoseconds } from "../../bindings/index.ts";
import { getDuckDBTimestampStringFromNanoseconds } from "../conversion/dateTimeStringConversion";
import { DuckDBTimestampNanosecondsValue } from "./DuckDBTimestampNanosecondsValue";
import { DuckDBTimestampTZValue } from "./DuckDBTimestampTZValue";

export class DuckDBTimestampTZNanosecondsValue implements TimestampNanoseconds {
  public readonly nanos: bigint;

  public constructor(nanos: bigint) {
    this.nanos = nanos;
  }

  public get isFinite(): boolean {
    return duckdb.is_finite_timestamp_ns(this);
  }

  /** Formats in the time zone set by `DuckDBTimestampTZValue.timezoneOffsetInMinutes`. */
  public toString(): string {
    return getDuckDBTimestampStringFromNanoseconds(this.nanos, DuckDBTimestampTZValue.timezoneOffsetInMinutes);
  }

  public static readonly Epoch = new DuckDBTimestampTZNanosecondsValue(0n);
  public static readonly Max = new DuckDBTimestampTZNanosecondsValue(DuckDBTimestampNanosecondsValue.Max.nanos);
  public static readonly Min = new DuckDBTimestampTZNanosecondsValue(DuckDBTimestampNanosecondsValue.Min.nanos);
  public static readonly PosInf = new DuckDBTimestampTZNanosecondsValue(DuckDBTimestampNanosecondsValue.PosInf.nanos);
  public static readonly NegInf = new DuckDBTimestampTZNanosecondsValue(DuckDBTimestampNanosecondsValue.NegInf.nanos);
}

export function timestampTZNanosValue(nanos: bigint): DuckDBTimestampTZNanosecondsValue {
  return new DuckDBTimestampTZNanosecondsValue(nanos);
}
