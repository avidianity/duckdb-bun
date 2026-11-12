// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

export interface ExpectedArrayVector {
  kind: "array";
  itemCount: number;
  validity: boolean[] | null;
  child: ExpectedVector;
}

export interface ExpectedDataVector {
  kind: "data";
  validity: boolean[] | null;
  itemBytes: number;
  values: any[];
}

export type ExpectedListEntry = [bigint, bigint] | null;

export interface ExpectedListVector {
  kind: "list";
  validity: boolean[] | null;
  entries: (ExpectedListEntry | null)[];
  childItemCount: number;
  child: ExpectedVector;
}

export interface ExpectedMapVector {
  kind: "map";
  validity: boolean[] | null;
  entries: (ExpectedListEntry | null)[];
  childItemCount: number;
  keys: ExpectedVector;
  values: ExpectedVector;
}

export interface ExpectedStructVector {
  kind: "struct";
  itemCount: number;
  validity: boolean[] | null;
  children: ExpectedVector[];
}

export interface ExpectedUnionVector {
  kind: "union";
  children: ExpectedVector[];
}

export type ExpectedVector =
  | ExpectedArrayVector
  | ExpectedDataVector
  | ExpectedListVector
  | ExpectedMapVector
  | ExpectedStructVector
  | ExpectedUnionVector;
