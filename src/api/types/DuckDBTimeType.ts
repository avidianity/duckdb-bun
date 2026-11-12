// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { DuckDBTimeValue } from "../values";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBTimeType extends BaseDuckDBType<DuckDBTypeId.TIME> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.TIME, alias);
  }
  public static readonly instance = new DuckDBTimeType();
  public static create(alias?: string): DuckDBTimeType {
    return alias ? new DuckDBTimeType(alias) : DuckDBTimeType.instance;
  }
  public get max() {
    return DuckDBTimeValue.Max;
  }
  public get min() {
    return DuckDBTimeValue.Min;
  }
}
export const TIME = DuckDBTimeType.instance;
