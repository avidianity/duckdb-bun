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
