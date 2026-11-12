// The @duckdb/node-api reference: the devDependency that parity, fuzz and the bench compare against (ADR 0009).
//
// It is a measuring stick, never a runtime dependency, and never holds a release back. A comparison is like with
// like only when the reference is built on the pinned DuckDB. After an upgrade to a DuckDB release that npm has no
// @duckdb/node-api for yet, the value comparisons (parity, fuzz) have nothing to compare against and report that,
// and the bench compares against the previous release of this package instead (bench/baseline.ts). The
// upstream-check workflow moves the reference once npm has one (MAINTENANCE.md, "Upgrading DuckDB").
import { join } from "node:path";
import { nodeApiBase } from "../scripts/upgrade-plan.ts";
import { DUCKDB_VERSION } from "../src/version.ts";

const manifest = join(import.meta.dir, "..", "node_modules", "@duckdb", "node-api", "package.json");

/** The installed @duckdb/node-api version. */
export const REFERENCE_VERSION: string = ((await Bun.file(manifest).json()) as { version: string }).version;

/** Whether the reference is built on the pinned DuckDB, so that comparing against it is like with like. */
export const HAS_REFERENCE: boolean = nodeApiBase(REFERENCE_VERSION) === DUCKDB_VERSION;

/** Why a value comparison does not run, for the test name and the log. */
export const NO_REFERENCE = `no @duckdb/node-api is built on DuckDB ${DUCKDB_VERSION} yet (the reference is ${REFERENCE_VERSION})`;
