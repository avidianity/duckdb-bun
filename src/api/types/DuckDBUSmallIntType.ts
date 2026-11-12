// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBUSmallIntType extends BaseDuckDBType<DuckDBTypeId.USMALLINT> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.USMALLINT, alias);
  }
  public static readonly instance = new DuckDBUSmallIntType();
  public static create(alias?: string): DuckDBUSmallIntType {
    return alias ? new DuckDBUSmallIntType(alias) : DuckDBUSmallIntType.instance;
  }
  public static readonly Max = 2 ** 16 - 1;
  public static readonly Min = 0;
  public get max() {
    return DuckDBUSmallIntType.Max;
  }
  public get min() {
    return DuckDBUSmallIntType.Min;
  }
}
export const USMALLINT = DuckDBUSmallIntType.instance;
