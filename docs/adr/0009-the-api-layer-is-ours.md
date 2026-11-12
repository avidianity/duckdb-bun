# 0009 The API layer is ours

Status: accepted, 2026-11-12.

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

## Rejected options

- Keeping the vendored layer and contributing every fix upstream: a fix waits for an upstream review and a release, and a DuckDB upgrade waits for duckdb-node-neo.
- Keeping the vendored layer and patching it on disk with a patch series: every re-vendor has to replay the series, and the layer still follows duckdb-node-neo's release cadence.
- Rewriting the API layer from scratch: the forked layer already passes its own suites and our parity tests, and a rewrite would risk drift from the public contract for no gain.

## Consequences

The API layer can change without upstream, and a DuckDB upgrade depends only on DuckDB's own release (MAINTENANCE.md, "Upgrading DuckDB").
New C API surface reaches the API layer only when we port it: duckdb-node-neo no longer does that work for us.
Biome and the type check now cover the forked code, which was reformatted once to the repository's style.
`@duckdb/node-api` stays a development dependency, the reference that parity, fuzz and the bench compare against.
