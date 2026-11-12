// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import type duckdb from "../../bindings/index.ts";
import { DuckDBListType, type DuckDBMapType, DuckDBStructType } from "../DuckDBType";
import { type DuckDBMapEntry, DuckDBMapValue, listValue, structValue } from "../values";
import { DuckDBListVector } from "./DuckDBListVector";
import { DuckDBStructVector } from "./DuckDBStructVector";
import { DuckDBVector } from "./DuckDBVector";

// MAP = LIST(STRUCT(key KEY_TYPE, value VALUE_TYPE))
export class DuckDBMapVector extends DuckDBVector<DuckDBMapValue> {
  private readonly mapType: DuckDBMapType;
  private readonly listVector: DuckDBListVector;
  constructor(mapType: DuckDBMapType, listVector: DuckDBListVector) {
    super();
    this.mapType = mapType;
    this.listVector = listVector;
  }
  static fromRawVector(mapType: DuckDBMapType, vector: duckdb.Vector, itemCount: number): DuckDBMapVector {
    const listVectorType = new DuckDBListType(
      new DuckDBStructType(["key", "value"], [mapType.keyType, mapType.valueType]),
    );
    return new DuckDBMapVector(mapType, DuckDBListVector.fromRawVector(listVectorType, vector, itemCount));
  }
  public override get type(): DuckDBMapType {
    return this.mapType;
  }
  public override get itemCount(): number {
    return this.listVector.itemCount;
  }
  public override getItem(itemIndex: number): DuckDBMapValue | null {
    const itemVector = this.listVector.getItemVector(itemIndex);
    if (!itemVector) {
      return null;
    }
    if (!(itemVector instanceof DuckDBStructVector)) {
      throw new Error("item in map list vector is not a struct");
    }
    const entries: DuckDBMapEntry[] = [];
    const itemEntryCount = itemVector.itemCount;
    for (let i = 0; i < itemEntryCount; i++) {
      const key = itemVector.getItemValue(i, 0);
      const value = itemVector.getItemValue(i, 1);
      entries.push({ key, value });
    }
    return new DuckDBMapValue(entries);
  }
  public override setItem(itemIndex: number, value: DuckDBMapValue | null) {
    if (value != null) {
      this.listVector.setItem(
        itemIndex,
        listValue(value.entries.map((entry) => structValue({ key: entry.key, value: entry.value }))),
      );
    } else {
      this.listVector.setItem(itemIndex, null);
    }
  }
  public override flush() {
    this.listVector.flush();
  }
  public override slice(offset: number, length: number): DuckDBMapVector {
    return new DuckDBMapVector(this.mapType, this.listVector.slice(offset, length));
  }
}
