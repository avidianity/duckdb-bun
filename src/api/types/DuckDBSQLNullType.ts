// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBSQLNullType extends BaseDuckDBType<DuckDBTypeId.SQLNULL> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.SQLNULL, alias);
  }
  /** DuckDB's name for the type, quoted because NULL is a keyword. */
  public toString(): string {
    return '"NULL"';
  }
  public static readonly instance = new DuckDBSQLNullType();
  public static create(alias?: string): DuckDBSQLNullType {
    return alias ? new DuckDBSQLNullType(alias) : DuckDBSQLNullType.instance;
  }
}
export const SQLNULL = DuckDBSQLNullType.instance;
