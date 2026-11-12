// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { DuckDBTypeId } from "../DuckDBTypeId";
import { DuckDBDateValue } from "../values";
import { BaseDuckDBType } from "./BaseDuckDBType";

export class DuckDBDateType extends BaseDuckDBType<DuckDBTypeId.DATE> {
  public constructor(alias?: string) {
    super(DuckDBTypeId.DATE, alias);
  }
  public static readonly instance = new DuckDBDateType();
  public static create(alias?: string): DuckDBDateType {
    return alias ? new DuckDBDateType(alias) : DuckDBDateType.instance;
  }
  public get epoch() {
    return DuckDBDateValue.Epoch;
  }
  public get max() {
    return DuckDBDateValue.Max;
  }
  public get min() {
    return DuckDBDateValue.Min;
  }
  public get posInf() {
    return DuckDBDateValue.PosInf;
  }
  public get negInf() {
    return DuckDBDateValue.NegInf;
  }
}
export const DATE = DuckDBDateType.instance;
