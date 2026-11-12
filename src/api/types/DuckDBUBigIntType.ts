// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBUBigIntType extends BaseDuckDBType<DuckDBTypeId.UBIGINT> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.UBIGINT, alias);
  }
  public static readonly instance = new DuckDBUBigIntType();
  public static create(alias?: string): DuckDBUBigIntType {
    return alias ? new DuckDBUBigIntType(alias) : DuckDBUBigIntType.instance;
  }
  public static readonly Max: bigint = 2n ** 64n - 1n;
  public static readonly Min: bigint = 0n;
  public get max() {
    return DuckDBUBigIntType.Max;
  }
  public get min() {
    return DuckDBUBigIntType.Min;
  }
}
export const UBIGINT = DuckDBUBigIntType.instance;
