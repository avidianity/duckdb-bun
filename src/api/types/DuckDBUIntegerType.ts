// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBUIntegerType extends BaseDuckDBType<DuckDBTypeId.UINTEGER> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.UINTEGER, alias);
  }
  public static readonly instance = new DuckDBUIntegerType();
  public static create(alias?: string): DuckDBUIntegerType {
    return alias ? new DuckDBUIntegerType(alias) : DuckDBUIntegerType.instance;
  }
  public static readonly Max = 2 ** 32 - 1;
  public static readonly Min = 0;
  public get max() {
    return DuckDBUIntegerType.Max;
  }
  public get min() {
    return DuckDBUIntegerType.Min;
  }
}
export const UINTEGER = DuckDBUIntegerType.instance;
