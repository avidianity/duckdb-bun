// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import type duckdb from "../../../src/bindings/index.ts";
import type { ExpectedLogicalType } from "./ExpectedLogicalType";
import type { ExpectedVector } from "./ExpectedVector";

export interface ExpectedColumn {
  name: string;
  logicalType: ExpectedLogicalType;
}

export interface ExpectedChunk {
  columnCount?: number;
  rowCount: number;
  vectors: ExpectedVector[];
}

export interface ExpectedResult {
  statementType?: duckdb.StatementType;
  resultType?: duckdb.ResultType;
  isStreaming?: boolean;
  chunkCount?: number;
  rowCount?: number;
  rowsChanged?: number;
  columns: ExpectedColumn[];
  chunks: ExpectedChunk[];
}
