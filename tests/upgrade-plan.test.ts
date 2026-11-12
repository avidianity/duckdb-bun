// The decisions behind the automated DuckDB upgrade (scripts/upgrade-plan.ts).

import { describe, expect, test } from "bun:test";
import {
  crateMinor,
  matchingCrate,
  nodeApiBase,
  setNeoTag,
  setTableRow,
  syncTestImports,
  upgradeTarget,
} from "../scripts/upgrade-plan.ts";

describe("upgradeTarget", () => {
  test("upgrades once a @duckdb/node-api built on the latest DuckDB is out", () => {
    expect(upgradeTarget("2.0.1", "2.0.1-r.1", "2.0.0-r.1")).toEqual({ duckdb: "2.0.1", nodeApi: "2.0.1-r.1" });
  });

  test("waits while the latest @duckdb/node-api is built on an older DuckDB", () => {
    expect(upgradeTarget("2.0.1", "2.0.0-r.1", "2.0.0-r.1")).toBeNull();
    expect(upgradeTarget("2.0.1", "2.0.0-r.2", "2.0.0-r.1")).toBeNull();
  });

  test("re-vendors a new @duckdb/node-api release on the pinned DuckDB", () => {
    expect(upgradeTarget("2.0.0", "2.0.0-r.2", "2.0.0-r.1")).toEqual({ duckdb: "2.0.0", nodeApi: "2.0.0-r.2" });
  });

  test("does nothing when the pin is current", () => {
    expect(upgradeTarget("2.0.0", "2.0.0-r.1", "2.0.0-r.1")).toBeNull();
  });
});

test("nodeApiBase reads the DuckDB version of a <duckdb>-r.<n> version", () => {
  expect(nodeApiBase("2.0.1-r.1")).toBe("2.0.1");
  expect(nodeApiBase("2.0.1")).toBeUndefined();
  expect(nodeApiBase("2.0.1-alpha.1")).toBeUndefined();
});

describe("libduckdb-sys", () => {
  test("crateMinor encodes MAJOR_MINOR_PATCH as duckdb-rs documents it", () => {
    expect(crateMinor("1.5.0")).toBe(10500);
    expect(crateMinor("1.5.6")).toBe(10506);
    expect(crateMinor("2.0.0")).toBe(20000);
    expect(crateMinor("2.0.1")).toBe(20001);
    expect(crateMinor("2.12.3")).toBe(21203);
  });

  test("crateMinor refuses versions the scheme cannot express", () => {
    expect(() => crateMinor("1.4.5")).toThrow("predates");
    expect(() => crateMinor("2.100.0")).toThrow("does not fit");
    expect(() => crateMinor("2.0")).toThrow("is not");
  });

  test("matchingCrate picks the newest release for that DuckDB that is not yanked", () => {
    const versions = [
      { num: "1.20001.2", yanked: true },
      { num: "1.20001.1", yanked: false },
      { num: "1.20001.0", yanked: false },
      { num: "1.20000.1", yanked: false },
      { num: "1.200010.0", yanked: false },
    ];
    expect(matchingCrate(versions, "2.0.1")).toBe("1.20001.1");
    expect(matchingCrate(versions, "2.0.0")).toBe("1.20000.1");
    expect(matchingCrate(versions, "2.0.2")).toBeUndefined();
  });
});

describe("setTableRow", () => {
  const table = ["| a | b |", "| - | - |", "| Tag     | `v2.0.0-r.1`    |", "| Commit  | `abc`           |", ""].join(
    "\n",
  );

  test("sets the value cell and keeps the column width", () => {
    expect(setTableRow(table, "Tag", "`v2.0.1-r.1`").split("\n")[2]).toBe("| Tag     | `v2.0.1-r.1`    |");
  });

  test("leaves a row that already holds the value unchanged", () => {
    expect(setTableRow(table, "Commit", "`abc`")).toBe(table);
  });

  test("throws for a missing row", () => {
    expect(() => setTableRow(table, "License", "MIT")).toThrow('expected one table row "License", found 0');
  });
});

describe("syncTestImports", () => {
  const prefix = 'import "../../vendor/x/test/';
  const source = ["// header", `${prefix}b.test.ts";`, `${prefix}a.test.ts";`, `${prefix}gone.test.ts";`, ""].join(
    "\n",
  );

  test("keeps the order of present files, drops removed ones and appends new ones sorted", () => {
    const result = syncTestImports(source, prefix, ["a.test.ts", "b.test.ts", "d.test.ts", "c.test.ts"]);
    expect(result.added).toEqual(["c.test.ts", "d.test.ts"]);
    expect(result.removed).toEqual(["gone.test.ts"]);
    expect(result.source).toBe(
      [
        "// header",
        `${prefix}b.test.ts";`,
        `${prefix}a.test.ts";`,
        `${prefix}c.test.ts";`,
        `${prefix}d.test.ts";`,
        "",
      ].join("\n"),
    );
  });

  test("is idempotent", () => {
    const once = syncTestImports(source, prefix, ["a.test.ts", "b.test.ts"]).source;
    expect(syncTestImports(once, prefix, ["a.test.ts", "b.test.ts"])).toEqual({ source: once, added: [], removed: [] });
  });

  test("throws when the imports are not one block", () => {
    expect(() => syncTestImports(`${prefix}a.test.ts";\nfoo();\n${prefix}b.test.ts";`, prefix, [])).toThrow(
      "not one block",
    );
  });
});

test("setNeoTag replaces the tag in a header comment, also across a wrapped line", () => {
  expect(setNeoTag("// suite (duckdb-node-neo v2.0.0-r.1, vendor)", "v2.0.1-r.1")).toBe(
    "// suite (duckdb-node-neo v2.0.1-r.1, vendor)",
  );
  expect(setNeoTag("// suite (duckdb-node-neo\n// v2.0.0-r.1, vendor)", "v2.0.1-r.1")).toBe(
    "// suite (duckdb-node-neo\n// v2.0.1-r.1, vendor)",
  );
  expect(() => setNeoTag("// no tag", "v2.0.1-r.1")).toThrow("names no duckdb-node-neo tag");
});
