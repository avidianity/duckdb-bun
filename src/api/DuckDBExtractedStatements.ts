// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../bindings/index.ts";
import { DuckDBPreparedStatement } from "./DuckDBPreparedStatement";
import type { DuckDBPreparedStatementCollection } from "./DuckDBPreparedStatementCollection";

export class DuckDBExtractedStatements {
  private readonly connection: duckdb.Connection;
  private readonly extracted_statements: duckdb.ExtractedStatements;
  private readonly statement_count: number;
  private readonly preparedStatements?: DuckDBPreparedStatementCollection;
  constructor(
    connection: duckdb.Connection,
    extracted_statements: duckdb.ExtractedStatements,
    statement_count: number,
    preparedStatements?: DuckDBPreparedStatementCollection,
  ) {
    this.connection = connection;
    this.extracted_statements = extracted_statements;
    this.statement_count = statement_count;
    this.preparedStatements = preparedStatements;
  }
  public get count(): number {
    return this.statement_count;
  }
  public async prepare(index: number): Promise<DuckDBPreparedStatement> {
    const prepared = new DuckDBPreparedStatement(
      await duckdb.prepare_extracted_statement(this.connection, this.extracted_statements, index),
    );
    if (this.preparedStatements) {
      this.preparedStatements.add(prepared);
    }
    return prepared;
  }
}
