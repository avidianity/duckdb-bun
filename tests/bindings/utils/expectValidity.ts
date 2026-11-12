// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import duckdb from "../../../src/bindings/index.ts";
import { expect } from "../../vitest-shim.ts";
import { isValid } from "./isValid";

export function expectValidity(
  validity_bytes: Uint8Array | null,
  validity: BigUint64Array | null,
  bit: number,
  expected: boolean,
  vectorName: string,
) {
  expect(duckdb.validity_row_is_valid(validity_bytes, bit), `${vectorName} validity_bytes_bit[${bit}]`).toBe(expected);
  expect(isValid(validity, bit), `${vectorName} validity_bit[${bit}]`).toBe(expected);
}
