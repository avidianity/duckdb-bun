// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { DuckDBTimestampTZValue } from "../values";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBTimestampTZType extends BaseDuckDBType<DuckDBTypeId.TIMESTAMP_TZ> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.TIMESTAMP_TZ, alias);
  }
  public toString(): string {
    return "TIMESTAMP WITH TIME ZONE";
  }
  public static readonly instance = new DuckDBTimestampTZType();
  public static create(alias?: string): DuckDBTimestampTZType {
    return alias ? new DuckDBTimestampTZType(alias) : DuckDBTimestampTZType.instance;
  }
  public get epoch() {
    return DuckDBTimestampTZValue.Epoch;
  }
  public get max() {
    return DuckDBTimestampTZValue.Max;
  }
  public get min() {
    return DuckDBTimestampTZValue.Min;
  }
  public get posInf() {
    return DuckDBTimestampTZValue.PosInf;
  }
  public get negInf() {
    return DuckDBTimestampTZValue.NegInf;
  }
}
export const TIMESTAMPTZ = DuckDBTimestampTZType.instance;
