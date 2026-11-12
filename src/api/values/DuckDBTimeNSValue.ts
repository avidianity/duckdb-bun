// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import type { TimeNS } from "../../bindings/index.ts";
import { getDuckDBTimeStringFromNanosecondsInDay } from "../conversion/dateTimeStringConversion";

export class DuckDBTimeNSValue implements TimeNS {
  public readonly nanos: bigint;

  public constructor(nanos: bigint) {
    this.nanos = nanos;
  }

  public toString(): string {
    return getDuckDBTimeStringFromNanosecondsInDay(this.nanos);
  }

  public static readonly Max = new DuckDBTimeNSValue(24n * 60n * 60n * 1000n * 1000n * 1000n);
  public static readonly Min = new DuckDBTimeNSValue(0n);
}

export function timeNSValue(nanos: bigint): DuckDBTimeNSValue {
  return new DuckDBTimeNSValue(nanos);
}
