# Provenance of the API layer

The API layer in this directory, the bindings contract and the API and bindings suites are forked from the official DuckDB Node "Neo" monorepo.
They are ours since the fork ([ADR 0009](../../docs/adr/0009-the-api-layer-is-ours.md)): we edit them like any other code, and upstream is not re-vendored.

|                                 |                                                   |
| ------------------------------- | ------------------------------------------------- |
| Upstream repository             | https://github.com/duckdb/duckdb-node-neo         |
| Fork tag                        | `v2.0.0-r.1`                                      |
| Fork commit                     | `769e55196b7e68c953c72618adbce553d54b777d`        |
| `@duckdb/node-api` version      | `2.0.0-r.1`                                       |
| `@duckdb/node-bindings` version | `2.0.0-r.1` (DuckDB core v2.0.0)                  |
| License                         | MIT, Stichting DuckDB Foundation, see `./LICENSE` |

## File mapping

| Upstream path                                     | Here                              |
| ------------------------------------------------- | --------------------------------- |
| `api/src/`                                        | `src/api/`                        |
| `bindings/pkgs/@duckdb/node-bindings/duckdb.d.ts` | `src/bindings/node-bindings.d.ts` |
| `api/test/`, without `bench/`                     | `tests/api/`                      |
| `bindings/test/`                                  | `tests/bindings/`                 |
| `LICENSE`                                         | `src/api/LICENSE`                 |

## Changes at the fork

- Imports of `@duckdb/node-bindings` point at `src/bindings/index.ts`, and imports of `vitest` at `tests/vitest-shim.ts`, by relative path.
- `tests/bindings/worker_threads.test.ts` and `tests/bindings/fixtures/scalarFunctionExit.cjs` load `src/bindings/index.ts` by path instead of resolving the package name.
- Biome formatted and linted every file; non-null assertions in the suites became `must()` from `tests/must.ts`.
- Each file starts with a two-line DuckDB Foundation copyright notice that points at `./LICENSE`.
- Upstream's `tsconfig.json` files and the API suite's Vitest benchmarks were left out.

Later changes are in the Git history of these paths.
