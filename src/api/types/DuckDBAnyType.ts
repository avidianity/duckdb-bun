// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBAnyType extends BaseDuckDBType<DuckDBTypeId.ANY> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.ANY, alias);
  }
  public static readonly instance = new DuckDBAnyType();
  public static create(alias?: string): DuckDBAnyType {
    return alias ? new DuckDBAnyType(alias) : DuckDBAnyType.instance;
  }
}
export const ANY = DuckDBAnyType.instance;
