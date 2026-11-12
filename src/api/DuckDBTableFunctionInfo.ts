// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../bindings/index.ts";

export class DuckDBTableFunctionInfo {
  private readonly function_info: duckdb.TableFunctionInfo;
  constructor(function_info: duckdb.TableFunctionInfo) {
    this.function_info = function_info;
  }
  public get extraInfo(): object | undefined {
    return this.getExtraInfo();
  }
  public getExtraInfo(): object | undefined {
    return duckdb.function_get_extra_info(this.function_info);
  }
  public get bindData(): object | undefined {
    return this.getBindData();
  }
  public getBindData(): object | undefined {
    return duckdb.function_get_bind_data(this.function_info);
  }
  public get initData(): object | undefined {
    return this.getInitData();
  }
  public getInitData(): object | undefined {
    return duckdb.function_get_init_data(this.function_info);
  }
  /** The init data set by the local init function, which is per scanning thread. */
  public get localInitData(): object | undefined {
    return this.getLocalInitData();
  }
  public getLocalInitData(): object | undefined {
    return duckdb.function_get_local_init_data(this.function_info);
  }
  public setError(error: string) {
    duckdb.function_set_error(this.function_info, error);
  }
}
