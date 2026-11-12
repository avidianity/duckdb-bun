// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { configurationOptionDescriptions, version } from "../../src/api";
import { assert, beforeAll, describe, test } from "../vitest-shim.ts";
import { setDefaultTimezone } from "./util/testHelpers";

describe("metadata", () => {
  beforeAll(setDefaultTimezone);

  test("should expose version", () => {
    const ver = version();
    assert.ok(ver.startsWith("v"), `version starts with 'v'`);
  });
  test("should expose configuration option descriptions", () => {
    const descriptions = configurationOptionDescriptions();
    assert.ok(descriptions.memory_limit, `descriptions has 'memory_limit'`);
  });
});
