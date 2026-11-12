// The package has its own stable semver version, and README.md "Versions" maps it to the DuckDB it
// bundles (ADR 0004). scripts/check-version.ts enforces the same in CI; this keeps `bun test` honest.
import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { libraryVersion } from "../src/index.ts";
import { DUCKDB_VERSION as EXPORTED } from "../src/neo.ts";
import { DUCKDB_VERSION, DUCKDB_VERSION_TAG } from "../src/version.ts";

test("the package version is a stable x.y.z version", () => {
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
});

test("README.md maps the package version to the pinned DuckDB and @duckdb/node-api", async () => {
  const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
  const nodeApi = pkg.devDependencies["@duckdb/node-api"];
  expect(readme).toContain(`| ${pkg.version} | ${DUCKDB_VERSION} | ${nodeApi} |`);
});

test("the main export names the bundled DuckDB, and the loaded libduckdb is that version", () => {
  expect(EXPORTED).toBe(DUCKDB_VERSION);
  expect(libraryVersion()).toBe(DUCKDB_VERSION_TAG);
});
