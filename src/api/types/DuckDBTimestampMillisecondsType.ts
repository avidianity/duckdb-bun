// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { DuckDBTimestampMillisecondsValue } from "../values";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBTimestampMillisecondsType extends BaseDuckDBType<DuckDBTypeId.TIMESTAMP_MS> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.TIMESTAMP_MS, alias);
  }
  public static readonly instance = new DuckDBTimestampMillisecondsType();
  public static create(alias?: string): DuckDBTimestampMillisecondsType {
    return alias ? new DuckDBTimestampMillisecondsType(alias) : DuckDBTimestampMillisecondsType.instance;
  }
  public get epoch() {
    return DuckDBTimestampMillisecondsValue.Epoch;
  }
  public get max() {
    return DuckDBTimestampMillisecondsValue.Max;
  }
  public get min() {
    return DuckDBTimestampMillisecondsValue.Min;
  }
  public get posInf() {
    return DuckDBTimestampMillisecondsValue.PosInf;
  }
  public get negInf() {
    return DuckDBTimestampMillisecondsValue.NegInf;
  }
}
export const TIMESTAMP_MS = DuckDBTimestampMillisecondsType.instance;
