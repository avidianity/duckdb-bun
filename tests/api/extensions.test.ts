// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "../../src/api";
import { afterAll, assert, beforeAll, describe, test } from "../vitest-shim.ts";

// The extensions built into libduckdb, which must load with no install or
// autoload: Node Neo links the prebuilt shared library and registers nothing.
const builtInExtensions = ["autocomplete", "core_functions", "icu", "json", "parquet"];

describe("built-in extensions", () => {
  let tempDir: string;
  let connection: DuckDBConnection;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-neo-extensions-"));
    const extensionDir = path.join(tempDir, "extensions");
    fs.mkdirSync(extensionDir);
    const instance = await DuckDBInstance.create(":memory:", {
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
      extension_directory: extensionDir,
    });
    connection = await instance.connect();
  });

  afterAll(() => {
    connection?.closeSync();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("are statically linked and loaded", async () => {
    const reader = await connection.runAndReadAll(
      `select extension_name, loaded, install_mode from duckdb_extensions()
       where loaded order by extension_name`,
    );
    const rows = reader.getRowObjectsJS();
    for (const name of builtInExtensions) {
      assert.deepInclude(
        rows,
        { extension_name: name, loaded: true, install_mode: "STATICALLY_LINKED" },
        `${name} should be statically linked and loaded`,
      );
    }
  });

  test("provide their functions", async () => {
    const parquetFile = path.join(tempDir, "x.parquet").replaceAll("\\", "/");
    await connection.run(`copy (select 1 as x) to '${parquetFile}' (format parquet)`);
    const reader = await connection.runAndReadAll(`
      select
        list_sum([1, 2, 3]) as core_functions,
        json_extract('{"a": 1}', '$.a')::integer as json,
        (select x from read_parquet('${parquetFile}')) as parquet,
        strftime(
          timestamptz '2024-01-01 00:00:00+00' at time zone 'Asia/Tokyo',
          '%H:%M'
        ) as icu
    `);
    assert.deepEqual(reader.getRowObjectsJS(), [{ core_functions: 6n, json: 1, parquet: 1, icu: "09:00" }]);
  });
});
