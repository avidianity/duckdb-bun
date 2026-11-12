// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBHugeIntType extends BaseDuckDBType<DuckDBTypeId.HUGEINT> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.HUGEINT, alias);
  }
  public static readonly instance = new DuckDBHugeIntType();
  public static create(alias?: string): DuckDBHugeIntType {
    return alias ? new DuckDBHugeIntType(alias) : DuckDBHugeIntType.instance;
  }
  public static readonly Max: bigint = 2n ** 127n - 1n;
  public static readonly Min: bigint = -(2n ** 127n);
  public get max() {
    return DuckDBHugeIntType.Max;
  }
  public get min() {
    return DuckDBHugeIntType.Min;
  }
}
export const HUGEINT = DuckDBHugeIntType.instance;
