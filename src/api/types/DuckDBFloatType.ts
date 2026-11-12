// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBFloatType extends BaseDuckDBType<DuckDBTypeId.FLOAT> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.FLOAT, alias);
  }
  public static readonly instance = new DuckDBFloatType();
  public static create(alias?: string): DuckDBFloatType {
    return alias ? new DuckDBFloatType(alias) : DuckDBFloatType.instance;
  }
  public static readonly Max = Math.fround(3.4028235e38);
  public static readonly Min = Math.fround(-3.4028235e38);
  public get max() {
    return DuckDBFloatType.Max;
  }
  public get min() {
    return DuckDBFloatType.Min;
  }
}
export const FLOAT = DuckDBFloatType.instance;
