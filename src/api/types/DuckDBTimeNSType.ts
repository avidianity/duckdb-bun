// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { DuckDBTimeNSValue } from "../values";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBTimeNSType extends BaseDuckDBType<DuckDBTypeId.TIME_NS> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.TIME_NS, alias);
  }
  public static readonly instance = new DuckDBTimeNSType();
  public static create(alias?: string): DuckDBTimeNSType {
    return alias ? new DuckDBTimeNSType(alias) : DuckDBTimeNSType.instance;
  }
  public get max() {
    return DuckDBTimeNSValue.Max;
  }
  public get min() {
    return DuckDBTimeNSValue.Min;
  }
}
export const TIME_NS = DuckDBTimeNSType.instance;
