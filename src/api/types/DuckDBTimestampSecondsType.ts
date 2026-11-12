// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { DuckDBTimestampSecondsValue } from "../values";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBTimestampSecondsType extends BaseDuckDBType<DuckDBTypeId.TIMESTAMP_S> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.TIMESTAMP_S, alias);
  }
  public static readonly instance = new DuckDBTimestampSecondsType();
  public static create(alias?: string): DuckDBTimestampSecondsType {
    return alias ? new DuckDBTimestampSecondsType(alias) : DuckDBTimestampSecondsType.instance;
  }
  public get epoch() {
    return DuckDBTimestampSecondsValue.Epoch;
  }
  public get max() {
    return DuckDBTimestampSecondsValue.Max;
  }
  public get min() {
    return DuckDBTimestampSecondsValue.Min;
  }
  public get posInf() {
    return DuckDBTimestampSecondsValue.PosInf;
  }
  public get negInf() {
    return DuckDBTimestampSecondsValue.NegInf;
  }
}
export const TIMESTAMP_S = DuckDBTimestampSecondsType.instance;
