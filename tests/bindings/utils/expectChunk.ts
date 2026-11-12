// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../../../src/bindings/index.ts";
import { expect } from "../../vitest-shim.ts";
import type { ExpectedChunk, ExpectedColumn } from "./ExpectedResult";
import { expectLogicalType } from "./expectLogicalType";
import { expectVector } from "./expectVector";

export function expectChunk(chunk: duckdb.DataChunk, expectedChunk: ExpectedChunk, expectedColumns: ExpectedColumn[]) {
  const chunkColumnCount = expectedChunk.columnCount ?? expectedColumns.length;
  expect(duckdb.data_chunk_get_column_count(chunk)).toBe(chunkColumnCount);
  expect(duckdb.data_chunk_get_size(chunk)).toBe(expectedChunk.rowCount);
  for (let col = 0; col < expectedChunk.vectors.length; col++) {
    const expectedVector = expectedChunk.vectors[col];
    const vector = duckdb.data_chunk_get_vector(chunk, col);
    const expectedLogicalType = expectedColumns[col].logicalType;
    expectLogicalType(duckdb.vector_get_column_type(vector), expectedLogicalType, `col ${col}`);
    expectVector(vector, expectedVector, expectedLogicalType, `col ${col}`);
  }
}
