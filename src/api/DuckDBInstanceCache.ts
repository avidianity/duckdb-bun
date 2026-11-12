// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../bindings/index.ts";
import { createConfig } from "./createConfig";
import { DuckDBInstance } from "./DuckDBInstance";

export class DuckDBInstanceCache {
  private readonly cache: duckdb.InstanceCache;

  constructor() {
    this.cache = duckdb.create_instance_cache();
  }

  public async getOrCreateInstance(path?: string, options?: Record<string, string>): Promise<DuckDBInstance> {
    const config = createConfig(options);
    const db = await duckdb.get_or_create_from_cache(this.cache, path, config);
    return new DuckDBInstance(db);
  }

  private static singletonInstance: DuckDBInstanceCache;

  public static get singleton(): DuckDBInstanceCache {
    if (!DuckDBInstanceCache.singletonInstance) {
      DuckDBInstanceCache.singletonInstance = new DuckDBInstanceCache();
    }
    return DuckDBInstanceCache.singletonInstance;
  }
}
