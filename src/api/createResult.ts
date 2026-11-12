// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../bindings/index.ts";
import { DuckDBMaterializedResult } from "./DuckDBMaterializedResult";
import { DuckDBResult } from "./DuckDBResult";
import type { StatementType } from "./enums";

export function createResult(result: duckdb.Result, preparedStatementType?: StatementType) {
  if (duckdb.result_is_streaming(result)) {
    return new DuckDBResult(result, preparedStatementType);
  } else {
    return new DuckDBMaterializedResult(result, preparedStatementType);
  }
}
