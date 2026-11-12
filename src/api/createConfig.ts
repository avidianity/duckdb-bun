// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../bindings/index.ts";

export function createConfig(options?: Record<string, string>): duckdb.Config {
  const config = duckdb.create_config();
  // Set the default duckdb_api value for the api. Can be overridden.
  duckdb.set_config(config, "duckdb_api", "node-neo-api");
  if (options) {
    for (const optionName in options) {
      const optionValue = String(options[optionName]);
      duckdb.set_config(config, optionName, optionValue);
    }
  }
  return config;
}
