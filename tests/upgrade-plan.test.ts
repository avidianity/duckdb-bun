// The decisions behind the automated DuckDB upgrade (scripts/upgrade-plan.ts).

import { describe, expect, test } from "bun:test";
import {
  crateMinor,
  matchingCrate,
  NO_REFERENCE,
  nodeApiBase,
  referenceFor,
  setReadmeRelease,
  upgradeTarget,
  upgradeVersion,
  versionRows,
} from "../scripts/upgrade-plan.ts";

describe("upgradeTarget", () => {
  const npm = ["2.0.0-r.1", "2.0.0-r.2", "2.0.1-r.1", "2.0.1-r.2", "1.5.0-r.1"];

  test("upgrades to a newer DuckDB release with the newest @duckdb/node-api built on it", () => {
    expect(upgradeTarget("2.0.1", "2.0.0", npm, "2.0.0-r.1")).toEqual({ duckdb: "2.0.1", nodeApi: "2.0.1-r.2" });
  });

  test("never waits for a @duckdb/node-api built on the new DuckDB", () => {
    expect(upgradeTarget("2.0.2", "2.0.0", npm, "2.0.0-r.1")).toEqual({ duckdb: "2.0.2", nodeApi: null });
  });

  test("refreshes the reference when npm has a newer one for the pinned DuckDB", () => {
    expect(upgradeTarget("2.0.0", "2.0.0", npm, "2.0.0-r.1")).toEqual({ duckdb: "2.0.0", nodeApi: "2.0.0-r.2" });
    expect(upgradeTarget("2.0.1", "2.0.1", npm, "2.0.0-r.2")).toEqual({ duckdb: "2.0.1", nodeApi: "2.0.1-r.2" });
  });

  test("does nothing when the pins are current", () => {
    expect(upgradeTarget("2.0.0", "2.0.0", npm, "2.0.0-r.2")).toBeNull();
    expect(upgradeTarget("2.0.2", "2.0.2", npm, "2.0.1-r.2")).toBeNull();
  });
});

test("referenceFor picks the newest @duckdb/node-api built on a DuckDB", () => {
  expect(referenceFor(["2.0.1-r.2", "2.0.1-r.10", "2.0.10-r.1", "2.0.1"], "2.0.1")).toBe("2.0.1-r.10");
  expect(referenceFor(["2.0.0-r.1"], "2.0.1")).toBeUndefined();
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

describe("the release version of an upgrade", () => {
  const readme = [
    "# duckdb-bun",
    "",
    "Version 1.0.2 bundles DuckDB v2.0.0; [Versions](#versions) maps every release.",
    "",
    "## Versions",
    "",
    "| `@avidian/duckdb-bun` | DuckDB | `@duckdb/node-api` reference |",
    "| --- | --- | --- |",
    "| 1.0.0 | 2.0.0 | 2.0.0-r.1 |",
    "| 1.0.2 | 2.0.0 | 2.0.0-r.1 |",
    "",
    "## Install",
    "",
  ].join("\n");

  test("reads the Versions rows", () => {
    expect(versionRows(readme)).toEqual([
      ["1.0.0", "2.0.0", "2.0.0-r.1"],
      ["1.0.2", "2.0.0", "2.0.0-r.1"],
    ]);
  });

  test("is the next minor version, or the one a second run already chose", () => {
    expect(upgradeVersion("1.0.2", versionRows(readme), "2.0.1")).toBe("1.1.0");
    const upgraded = setReadmeRelease(readme, "1.1.0", "2.0.1", "2.0.1-r.1");
    expect(upgradeVersion("1.1.0", versionRows(upgraded), "2.0.1")).toBe("1.1.0");
    expect(() => upgradeVersion("1.0.2-r.1", [], "2.0.1")).toThrow("is not <major>.<minor>.<patch>");
  });

  test("names the release in the opening sentence and a new last row", () => {
    const upgraded = setReadmeRelease(readme, "1.1.0", "2.0.1", "2.0.1-r.1");
    expect(upgraded).toContain("Version 1.1.0 bundles DuckDB v2.0.1; [Versions]");
    expect(versionRows(upgraded).at(-1)).toEqual(["1.1.0", "2.0.1", "2.0.1-r.1"]);
    expect(upgraded).toContain("| 1.1.0 | 2.0.1 | 2.0.1-r.1 |\n\n## Install");
    expect(setReadmeRelease(upgraded, "1.1.0", "2.0.1", "2.0.1-r.2")).toBe(
      upgraded.replace("| 2.0.1-r.1 |", "| 2.0.1-r.2 |"),
    );
  });

  test("writes none when npm has no @duckdb/node-api built on the DuckDB", () => {
    const upgraded = setReadmeRelease(readme, "1.1.0", "2.0.1", undefined);
    expect(versionRows(upgraded).at(-1)).toEqual(["1.1.0", "2.0.1", NO_REFERENCE]);
  });

  test("reads the older sentence that also named a @duckdb/node-api", () => {
    const older = readme.replace("DuckDB v2.0.0;", "DuckDB v2.0.0 and matches `@duckdb/node-api` 2.0.0-r.1;");
    expect(setReadmeRelease(older, "1.1.0", "2.0.1", undefined)).toContain(
      "Version 1.1.0 bundles DuckDB v2.0.1; [Versions]",
    );
  });

  test("matches the real README", async () => {
    const real = await Bun.file(new URL("../README.md", import.meta.url)).text();
    const rows = versionRows(real);
    const version = upgradeVersion(rows.at(-1)?.[0] ?? "", rows, "99.0.0");
    expect(versionRows(setReadmeRelease(real, version, "99.0.0", "99.0.0-r.1")).at(-1)).toEqual([
      version,
      "99.0.0",
      "99.0.0-r.1",
    ]);
  });
});
