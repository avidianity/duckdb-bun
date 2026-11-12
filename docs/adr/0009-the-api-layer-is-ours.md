# 0009 The API layer is ours

Status: accepted, 2026-11-12; amended 2026-11-12 with the upgrade path and the reference.

## Context

Until now the TypeScript API layer was the official `@duckdb/node-api` source, vendored in `vendor/node-api/src` and used unmodified except for one import rewrite.
Its two test suites, the `@duckdb/node-api` and `@duckdb/node-bindings` Vitest suites, were vendored next to it and ran unmodified through a test preload that rewrote their imports at load time.
A fix or an improvement to the API layer had to land upstream first, in duckdb-node-neo.
A DuckDB upgrade re-vendored duckdb-node-neo at a new tag, so a new DuckDB release reached this package only after duckdb-node-neo published a `@duckdb/node-api` built on it.

The maintainer wants the package independent of the official Node API: no fix, improvement or DuckDB release waits for duckdb-node-neo.

## Decision

The API layer and its suites are ours, forked from duckdb-node-neo `v2.0.0-r.1` (commit `769e55196b7e68c953c72618adbce553d54b777d`).

- `src/api/` holds the API layer, from `api/src`.
- `src/bindings/node-bindings.d.ts` holds the bindings contract that `src/bindings/` implements, from `bindings/pkgs/@duckdb/node-bindings/duckdb.d.ts`.
- `tests/api/` holds the API suite, from `api/test`, and `tests/bindings/` holds the bindings suite, from `bindings/test`.
  The suites import `tests/vitest-shim.ts` and our bindings by relative path, so there is no test preload.
- We edit these files like any other code: a fix lands where the behavior lives, in `src/api/` or in `src/bindings/`, with a test in the same change.
- Each derived file starts with the DuckDB Foundation copyright line, and `src/api/LICENSE`, which the published package includes, holds the MIT notice that the licence requires to travel with the code.
  `src/api/PROVENANCE.md` records the fork point and the file mapping.
- The duckdb-node-neo upstream is not re-vendored again.
  A change there is a lead: port it by hand when it fixes something we share, as with any other reference.

The public contract stays the `@duckdb/node-api` API: same classes, same value objects, same error text.
The official C++ binding at the fork tag stays the reference for the semantics of the bindings that exist at that tag.

### Amendment: upgrades follow DuckDB core alone

A DuckDB upgrade needs only DuckDB's own release: `bun run upgrade-duckdb --duckdb <new>` sets `DUCKDB_VERSION`, fetches libduckdb and `duckdb.h` from the release assets, regenerates the FFI tables from DuckDB's C API spec, and runs our suites in CI.
The `upstream-check` workflow opens the upgrade pull request as soon as DuckDB publishes a release newer than the pin.
New C API surface reaches the API when we port it to `src/bindings/node-bindings.d.ts`, `src/bindings/` and `src/api/`.

### Amendment: `@duckdb/node-api` is a reference, never a gate

`@duckdb/node-api` stays a development dependency only, never a runtime dependency, as the reference that parity, fuzz and the bench compare against (`tests/reference.ts`).
It is built on the pinned DuckDB, or on an older one while npm has none for the pin.

- When it is built on the pinned DuckDB, parity, fuzz and the bench gate compare against it.
- When it is not, parity and fuzz report that they have nothing to compare against, and the bench gate compares against the previous release of this package on npm (`bench/baseline.ts`).
  A comparison across two DuckDB versions would fail on DuckDB's own changes, and would hold a release back on a package we do not control.
- The upgrade pins the newest `@duckdb/node-api` built on the new DuckDB when npm has one, and `upstream-check` opens a pull request that moves the reference once npm publishes one later.
- The `Versions` table names the reference each release was compared against, or `none`.

## Rejected options

- Keeping the vendored layer and contributing every fix upstream: a fix waits for an upstream review and a release, and a DuckDB upgrade waits for duckdb-node-neo.
- Keeping the vendored layer and patching it on disk with a patch series: every re-vendor has to replay the series, and the layer still follows duckdb-node-neo's release cadence.
- Rewriting the API layer from scratch: the forked layer already passes its own suites and our parity tests, and a rewrite would risk drift from the public contract for no gain.
- Comparing against an `@duckdb/node-api` built on an older DuckDB: differences in DuckDB itself would fail parity and hold the release back.
- Dropping the `@duckdb/node-api` comparison: it is the only check that the public contract still behaves like the official package.

## Consequences

The API layer can change without upstream, and a DuckDB upgrade depends only on DuckDB's own release (MAINTENANCE.md, "Upgrading DuckDB").
New C API surface reaches the API layer only when we port it: duckdb-node-neo no longer does that work for us.
Biome and the type check now cover the forked code, which was reformatted once to the repository's style.
While npm has no `@duckdb/node-api` for the pinned DuckDB, nothing checks parity with the official package; the window closes when the reference pull request merges.
