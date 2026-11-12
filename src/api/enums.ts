// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../bindings/index.ts";

export type ResultReturnType = duckdb.ResultType;
export const ResultReturnType = duckdb.ResultType;

export type StatementType = duckdb.StatementType;
export const StatementType = duckdb.StatementType;
