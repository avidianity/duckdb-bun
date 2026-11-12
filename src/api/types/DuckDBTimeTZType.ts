// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { DuckDBTimeTZValue } from "../values";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBTimeTZType extends BaseDuckDBType<DuckDBTypeId.TIME_TZ> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.TIME_TZ, alias);
  }
  public toString(): string {
    return "TIME WITH TIME ZONE";
  }
  public static readonly instance = new DuckDBTimeTZType();
  public static create(alias?: string): DuckDBTimeTZType {
    return alias ? new DuckDBTimeTZType(alias) : DuckDBTimeTZType.instance;
  }
  public get max() {
    return DuckDBTimeTZValue.Max;
  }
  public get min() {
    return DuckDBTimeTZValue.Min;
  }
}
export const TIMETZ = DuckDBTimeTZType.instance;
