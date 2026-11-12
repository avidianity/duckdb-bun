# 0004 The package has its own semantic version

Status: accepted, 2026-11-12.

## Context

The package version was `<duckdb>-r.<n>`, the scheme `@duckdb/node-api` uses: `2.0.0-r.0` wrapped DuckDB 2.0.0.
Semver reads `-r.<n>` as a prerelease, so a range such as `^2.0.0` skips every release, and npm needs an explicit dist-tag to publish one.
The scheme also leaves no room for a fix of our own: a fix on DuckDB 2.0.0 cannot be `2.0.1`, which belongs to DuckDB 2.0.1.
Nothing had been published under the old scheme when this was decided.

## Decision

The main package and every platform package share one stable semantic version, independent of DuckDB's, starting at 1.0.0 for DuckDB 2.0.0.
A DuckDB upgrade, minor or patch, that keeps the API bumps the minor version.
A fix of our own bumps the patch version.
An API break bumps the major version.
No version is a prerelease.

The `Versions` table in `README.md` maps each package version to the DuckDB it bundles and the `@duckdb/node-api` it matches, and `bun run check-version` fails when the current version has no row.
At run time, the package exports `DUCKDB_VERSION`, and `diagnostics().versions` reports the package, DuckDB, Bun and shim versions.

## Rejected options

- Keeping `<duckdb>-r.<n>`: ranges skip it, and our fixes have no version number of their own.
- Mirroring DuckDB's version without a suffix: the same collision between our fixes and the next DuckDB patch.

## Consequences

A user cannot read the DuckDB version from the package version; the README table and `DUCKDB_VERSION` answer that.
The upgrade automation never sets the package version; a human picks it when releasing.
