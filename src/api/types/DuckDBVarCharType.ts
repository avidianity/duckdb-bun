// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBVarCharType extends BaseDuckDBType<DuckDBTypeId.VARCHAR> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.VARCHAR, alias);
  }
  public static readonly instance = new DuckDBVarCharType();
  public static create(alias?: string): DuckDBVarCharType {
    return alias ? new DuckDBVarCharType(alias) : DuckDBVarCharType.instance;
  }
}
export const VARCHAR = DuckDBVarCharType.instance;
