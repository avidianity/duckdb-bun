// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBBigIntType extends BaseDuckDBType<DuckDBTypeId.BIGINT> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.BIGINT, alias);
  }
  public static readonly instance = new DuckDBBigIntType();
  public static create(alias?: string): DuckDBBigIntType {
    return alias ? new DuckDBBigIntType(alias) : DuckDBBigIntType.instance;
  }
  public static readonly Max: bigint = 2n ** 63n - 1n;
  public static readonly Min: bigint = -(2n ** 63n);
  public get max() {
    return DuckDBBigIntType.Max;
  }
  public get min() {
    return DuckDBBigIntType.Min;
  }
}
export const BIGINT = DuckDBBigIntType.instance;
