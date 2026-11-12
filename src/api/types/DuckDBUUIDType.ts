// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { DuckDBUUIDValue } from "../values";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBUUIDType extends BaseDuckDBType<DuckDBTypeId.UUID> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.UUID, alias);
  }
  public static readonly instance = new DuckDBUUIDType();
  public static create(alias?: string): DuckDBUUIDType {
    return alias ? new DuckDBUUIDType(alias) : DuckDBUUIDType.instance;
  }
  public get max() {
    return DuckDBUUIDValue.Max;
  }
  public get min() {
    return DuckDBUUIDValue.Min;
  }
}
export const UUID = DuckDBUUIDType.instance;
