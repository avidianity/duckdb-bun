# 0005 Linux arm64 is a platform package

Status: accepted, 2026-11-12.

## Context

The 1.0.0 release shipped platform packages for linux-x64 (glibc) and darwin-arm64 only.
Arm64 Linux hosts and Docker on Apple silicon Macs, which runs arm64 Linux images by default, had no package and failed at load time.
DuckDB v2.0.0 publishes `duckdb-shared-libs-linux-arm64.tar.gz` for glibc, and `@duckdb/node-api` 2.0.0-r.1 ships `@duckdb/node-bindings-linux-arm64`, so both the library and the parity reference exist.
GitHub-hosted `ubuntu-24.04-arm` runners are free for public repositories, so the platform can run every suite natively.

## Decision

`@avidian/duckdb-bun-linux-arm64` ships `libduckdb.so` and `libduckdb_bun_shim.so` for `os: linux`, `cpu: arm64`, `libc: glibc`, beside the other platform packages and with the same version.
Its shim is built natively on an `ubuntu-24.04-arm` runner, in the same `rust:1.99.1-bookworm` image index as the linux-x64 shim, pinned by the same index digest, so both Linux packages need glibc 2.36 or newer.
There is no cross build: CI and the release workflow test the package on that runner like every other platform.
The release workflow publishes it before the main package, which lists it in `optionalDependencies`.

## Rejected options

- Cross-compiling the shim on an x64 runner: the package would ship without running its tests on arm64.
- A musl package (`linux-arm64-musl`, or Alpine): DuckDB publishes musl libraries, but `oven/bun` slim images are glibc, and a musl package needs its own build image; it can follow as its own platform.

## Consequences

The package name, its `os`, `cpu` and `libc`, and its file list are published and hard to change.
Every release builds and tests one more platform, and npm needs one more trusted publisher, four in all.
