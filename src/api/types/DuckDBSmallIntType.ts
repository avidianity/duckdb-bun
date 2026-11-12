// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBSmallIntType extends BaseDuckDBType<DuckDBTypeId.SMALLINT> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.SMALLINT, alias);
  }
  public static readonly instance = new DuckDBSmallIntType();
  public static create(alias?: string): DuckDBSmallIntType {
    return alias ? new DuckDBSmallIntType(alias) : DuckDBSmallIntType.instance;
  }
  public static readonly Max = 2 ** 15 - 1;
  public static readonly Min = -(2 ** 15);
  public get max() {
    return DuckDBSmallIntType.Max;
  }
  public get min() {
    return DuckDBSmallIntType.Min;
  }
}
export const SMALLINT = DuckDBSmallIntType.instance;
