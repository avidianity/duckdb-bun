// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBIntegerLiteralType extends BaseDuckDBType<DuckDBTypeId.INTEGER_LITERAL> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.INTEGER_LITERAL, alias);
  }
  public static readonly instance = new DuckDBIntegerLiteralType();
  public static create(alias?: string): DuckDBIntegerLiteralType {
    return alias ? new DuckDBIntegerLiteralType(alias) : DuckDBIntegerLiteralType.instance;
  }
}
export const INTEGER_LITERAL = DuckDBIntegerLiteralType.instance;
