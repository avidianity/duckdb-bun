// scripts/coverage.ts: reading lcov reports and adding the hits of a second build of the same source.

import { describe, expect, test } from "bun:test";
import { addHits, parseLcov, totals } from "../scripts/coverage.ts";

const ROOT = "/repo";

/** The shim's report of diag.rs: two functions, one never called. */
const SHIM = [
  "SF:/repo/native/src/diag.rs",
  "FN:10,_RNvNtCs1_15duckdb_bun_shim4diag7op_name",
  "FN:20,_RNvNtCs1_15duckdb_bun_shim4diag6record",
  "FNDA:0,_RNvNtCs1_15duckdb_bun_shim4diag7op_name",
  "FNDA:5,_RNvNtCs1_15duckdb_bun_shim4diag6record",
  "FNF:2",
  "FNH:1",
  "DA:10,0",
  "DA:11,0",
  "DA:20,5",
  "DA:21,5",
  "end_of_record",
  "",
].join("\n");

/** native/diag-tests' report of the same file, reached through a `..` path, with its own unit test at line 30. */
const DIAG_TESTS = [
  "SF:/repo/native/diag-tests/src/../../src/diag.rs",
  "FN:10,_RNvNtCs2_21duckdb_bun_diag_tests4diag7op_name",
  "FN:30,_RNvNtNtCs2_21duckdb_bun_diag_tests4diag5tests4test",
  "FNDA:3,_RNvNtCs2_21duckdb_bun_diag_tests4diag7op_name",
  "FNDA:1,_RNvNtNtCs2_21duckdb_bun_diag_tests4diag5tests4test",
  "FNF:2",
  "FNH:2",
  "DA:10,3",
  "DA:11,3",
  "DA:30,1",
  "end_of_record",
  "SF:/repo/native/diag-tests/src/main.rs",
  "DA:1,1",
  "end_of_record",
  "",
].join("\n");

describe("parseLcov", () => {
  test("keys files by their path from the root, with `..` resolved", () => {
    expect([...parseLcov(DIAG_TESTS, ROOT).keys()]).toEqual(["native/src/diag.rs", "native/diag-tests/src/main.rs"]);
  });

  test("counts named functions by the line they start on", () => {
    const file = parseLcov(SHIM, ROOT).get("native/src/diag.rs");
    expect(file?.functions).toEqual(
      new Map([
        [10, 0],
        [20, 5],
      ]),
    );
    expect(totals(file ? [file] : [])).toEqual({ linesFound: 4, linesHit: 2, functionsFound: 2, functionsHit: 1 });
  });

  test("uses FNF and FNH when the report does not name its functions, as Bun's does", () => {
    const file = parseLcov("SF:/repo/src/a.ts\nFNF:4\nFNH:3\nDA:1,1\nDA:2,0\nend_of_record\n", ROOT).get("src/a.ts");
    expect(totals(file ? [file] : [])).toEqual({ linesFound: 2, linesHit: 1, functionsFound: 4, functionsHit: 3 });
  });
});

describe("addHits", () => {
  test("counts the other build's hits only on lines and functions the base report measures", () => {
    const base = parseLcov(SHIM, ROOT);
    addHits(base, parseLcov(DIAG_TESTS, ROOT));
    const file = base.get("native/src/diag.rs");
    expect(file?.lines).toEqual(
      new Map([
        [10, 3],
        [11, 3],
        [20, 5],
        [21, 5],
      ]),
    );
    expect(totals(file ? [file] : [])).toEqual({ linesFound: 4, linesHit: 4, functionsFound: 2, functionsHit: 2 });
    expect([...base.keys()]).toEqual(["native/src/diag.rs"]);
  });
});
