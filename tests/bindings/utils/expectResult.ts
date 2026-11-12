// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../../../src/bindings/index.ts";
import { expect } from "../../vitest-shim.ts";
import type { ExpectedResult } from "./ExpectedResult";
import { expectChunk } from "./expectChunk";
import { expectLogicalType } from "./expectLogicalType";

export async function expectResult(
  result: duckdb.Result,
  expectedResult: ExpectedResult,
  prepared?: duckdb.PreparedStatement,
) {
  const expectedStatementType = expectedResult.statementType ?? duckdb.StatementType.SELECT;
  const statementType = duckdb.result_statement_type(result);
  // On DuckDB 2.0, results of prepared statements report EXECUTE; see https://github.com/duckdb/duckdb/issues/27415
  if (prepared && statementType === duckdb.StatementType.EXECUTE) {
    expect(duckdb.prepared_statement_type(prepared)).toBe(expectedStatementType);
  } else {
    expect(statementType).toBe(expectedStatementType);
  }
  expect(duckdb.result_return_type(result)).toBe(expectedResult.resultType ?? duckdb.ResultType.QUERY_RESULT);
  expect(duckdb.result_is_streaming(result)).toBe(!!expectedResult.isStreaming);
  if (expectedResult.chunkCount != null) {
    expect(duckdb.result_chunk_count(result)).toBe(expectedResult.chunkCount);
  }
  if (expectedResult.rowCount != null) {
    expect(duckdb.row_count(result)).toBe(expectedResult.rowCount);
  }
  expect(duckdb.rows_changed(result)).toBe(expectedResult.rowsChanged ?? 0);
  expect(duckdb.column_count(result)).toBe(expectedResult.columns.length);
  for (let col = 0; col < expectedResult.columns.length; col++) {
    const expectedColumn = expectedResult.columns[col];
    expect(duckdb.column_name(result, col), `${col}`).toBe(expectedColumn.name);
    expect(duckdb.column_type(result, col), `${col}`).toBe(expectedColumn.logicalType.typeId);
    expectLogicalType(duckdb.column_logical_type(result, col), expectedColumn.logicalType, `col ${col}`);
  }
  if (expectedResult.chunkCount != null && expectedResult.chunkCount > 0) {
    for (let chunkIndex = 0; chunkIndex < expectedResult.chunkCount; chunkIndex++) {
      const chunk = duckdb.result_get_chunk(result, chunkIndex);
      expectChunk(chunk, expectedResult.chunks[chunkIndex], expectedResult.columns);
    }
  }
  for (const expectedChunk of expectedResult.chunks) {
    const chunk = await duckdb.fetch_chunk(result);
    expect(chunk).toBeDefined();
    if (chunk) {
      expectChunk(chunk, expectedChunk, expectedResult.columns);
    }
  }
}
