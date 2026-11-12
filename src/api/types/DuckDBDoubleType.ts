// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBDoubleType extends BaseDuckDBType<DuckDBTypeId.DOUBLE> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.DOUBLE, alias);
  }
  public static readonly instance = new DuckDBDoubleType();
  public static create(alias?: string): DuckDBDoubleType {
    return alias ? new DuckDBDoubleType(alias) : DuckDBDoubleType.instance;
  }
  public static readonly Max = Number.MAX_VALUE;
  public static readonly Min = -Number.MAX_VALUE;
  public get max() {
    return DuckDBDoubleType.Max;
  }
  public get min() {
    return DuckDBDoubleType.Min;
  }
}
export const DOUBLE = DuckDBDoubleType.instance;
