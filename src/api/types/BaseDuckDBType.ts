// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../../bindings/index.ts";
import { DuckDBLogicalType } from "../DuckDBLogicalType";
import { DuckDBTypeId } from "../DuckDBTypeId";
import type { Json } from "../Json";

export abstract class BaseDuckDBType<T extends DuckDBTypeId> {
  public readonly typeId: T;
  public readonly alias?: string;
  protected constructor(typeId: T, alias?: string) {
    this.typeId = typeId;
    this.alias = alias;
  }
  public toString(): string {
    return DuckDBTypeId[this.typeId];
  }
  public toLogicalType(): DuckDBLogicalType {
    const logicalType = DuckDBLogicalType.create(duckdb.create_logical_type(this.typeId as number as duckdb.Type));
    if (this.alias) {
      logicalType.alias = this.alias;
    }
    return logicalType;
  }
  public toJson(): Json {
    return {
      typeId: this.typeId,
      ...(this.alias ? { alias: this.alias } : {}),
    };
  }
}
