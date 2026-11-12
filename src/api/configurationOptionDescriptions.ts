// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../bindings/index.ts";

export function configurationOptionDescriptions(): Readonly<Record<string, string>> {
  const descriptions: Record<string, string> = {};
  const count = duckdb.config_count();
  for (let i = 0; i < count; i++) {
    const { name, description } = duckdb.get_config_flag(i);
    descriptions[name] = description;
  }
  return descriptions;
}
