// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBUTinyIntType extends BaseDuckDBType<DuckDBTypeId.UTINYINT> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.UTINYINT, alias);
  }
  public static readonly instance = new DuckDBUTinyIntType();
  public static create(alias?: string): DuckDBUTinyIntType {
    return alias ? new DuckDBUTinyIntType(alias) : DuckDBUTinyIntType.instance;
  }
  public static readonly Max = 2 ** 8 - 1;
  public static readonly Min = 0;
  public get max() {
    return DuckDBUTinyIntType.Max;
  }
  public get min() {
    return DuckDBUTinyIntType.Min;
  }
}
export const UTINYINT = DuckDBUTinyIntType.instance;
