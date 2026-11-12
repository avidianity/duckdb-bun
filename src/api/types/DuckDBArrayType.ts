// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBLogicalType } from "../DuckDBLogicalType";
import { DuckDBTypeId } from "../DuckDBTypeId";
import type { Json } from "../Json";
import { BaseDuckDBType } from "./BaseDuckDBType";
import type { DuckDBType } from "./DuckDBType";

export class DuckDBArrayType extends BaseDuckDBType<DuckDBTypeId.ARRAY> {
  public readonly valueType: DuckDBType;
  public readonly length: number;
  public constructor(valueType: DuckDBType, length: number, alias?: string) {
    super(DuckDBTypeId.ARRAY, alias);
    this.valueType = valueType;
    this.length = length;
  }
  public toString(): string {
    return `${this.valueType}[${this.length}]`;
  }
  public override toLogicalType(): DuckDBLogicalType {
    const logicalType = DuckDBLogicalType.createArray(this.valueType.toLogicalType(), this.length);
    if (this.alias) {
      logicalType.alias = this.alias;
    }
    return logicalType;
  }
  public override toJson(): Json {
    return {
      typeId: this.typeId,
      valueType: this.valueType.toJson(),
      length: this.length,
      ...(this.alias ? { alias: this.alias } : {}),
    };
  }
}
export function ARRAY(valueType: DuckDBType, length: number, alias?: string): DuckDBArrayType {
  return new DuckDBArrayType(valueType, length, alias);
}
