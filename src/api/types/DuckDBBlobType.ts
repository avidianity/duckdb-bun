// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBBlobType extends BaseDuckDBType<DuckDBTypeId.BLOB> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.BLOB, alias);
  }
  public static readonly instance = new DuckDBBlobType();
  public static create(alias?: string): DuckDBBlobType {
    return alias ? new DuckDBBlobType(alias) : DuckDBBlobType.instance;
  }
}
export const BLOB = DuckDBBlobType.instance;
