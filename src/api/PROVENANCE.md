# Vendored `@duckdb/node-api` and `@duckdb/node-bindings` tests

These trees are copied **verbatim** from the official DuckDB Node "Neo" monorepo.
We reimplement the bindings over `bun:ffi` and prove parity against the official test suites.

|                                 |                                                     |
| ------------------------------- | --------------------------------------------------- |
| Upstream repo                   | https://github.com/duckdb/duckdb-node-neo           |
| Tag                             | `v2.0.0-r.1`                                        |
| Commit                          | `769e55196b7e68c953c72618adbce553d54b777d`          |
| `@duckdb/node-api` version      | `2.0.0-r.1`                                         |
| `@duckdb/node-bindings` version | `2.0.0-r.1` (DuckDB core v2.0.0)                    |
| License                         | MIT, see `./LICENSE` and `../node-bindings/LICENSE` |

## Layout

- `src/` is copied from `api/src/`.
  It is the full TypeScript API layer, **unmodified on disk** except for the import rewrite described below.
- `test/` is copied from `api/test/`.
  It is the official `@duckdb/node-api` Vitest suite, with `util/` and `bench/`; we do not run `bench/`.
  It is **unmodified on disk**.
- `node-bindings.d.ts` is copied from `bindings/pkgs/@duckdb/node-bindings/duckdb.d.ts`.
  It is the exact interface contract that our `src/bindings/` reimplements, and the source of truth for `scripts/gen-contract.ts`.
- `../node-bindings/test/` is copied from `bindings/test/`.
  It is the official `@duckdb/node-bindings` Vitest suite, with `utils/`, `fixtures/` and `stress/`.
  It is **unmodified on disk**.
- `../node-bindings/LICENSE` is the upstream license that covers the bindings tests.

## How it's wired

- The `@duckdb/node-bindings` imports in `src/` are rewritten **on disk** to a relative import of our `src/bindings/` by `scripts/vendor-rewrite-bindings.ts`.
  That is the only modification against upstream; every other line is byte-identical.
  It makes the published package a plugin-free drop-in: consumers `import { DuckDBInstance } from '@avidian/duckdb-bun'`, and the vendored layer loads our `bun:ffi` bindings directly, with nothing else in the resolution path.
- The `vitest` imports in both test suites can't be rewritten on disk the same way, because they would need `vitest` installed for the editor and the type checker.
  `bun test` also hard-remaps `vitest` to `bun:test`, which lacks an `assert` export, before tsconfig `paths` or a plugin `onResolve` run.
  So `tests/preload.ts` uses an **`onLoad`** plugin, scoped to the two `test/` directories, that rewrites `vitest` to `tests/vitest-shim.ts` at load time.
  The shim re-exports the `bun:test` runner primitives and chai's `assert`, which is what vitest's `assert` is.
- The same `onLoad` plugin rewrites the bindings suite's ESM `@duckdb/node-bindings` imports to our `src/bindings/`.
- The bindings suite also resolves `@duckdb/node-bindings` through CommonJS: `worker_threads.test.ts` calls `createRequire(...).resolve()`, and `scalar_function_exit.test.ts` spawns `bun` on `fixtures/scalarFunctionExit.cjs`, which calls `require()`.
  `tests/node-bindings-resolve.ts` overrides `Module._resolveFilename` for requests from `../node-bindings/test/`, and `tests/preload.ts` loads it in the test process and adds it to `BUN_OPTIONS` for every spawned `bun` process.
- `tests/official/api.test.ts` (`bun run test:official`) and `tests/official/bindings.test.ts` (`bun run test:bindings`) import every test file of the respective suite.
  `bindings.test.ts` leaves out `stress/`, which is heavy and runs one file at a time.

## Updating (on a DuckDB version bump)

`scripts/upgrade-duckdb.ts` (`bun run upgrade-duckdb`) does steps 1 to 5 and updates the table above; MAINTENANCE.md "Upgrading DuckDB" describes when it runs.

1. Check out the upstream tag `v<version>` whose `api/pkgs/@duckdb/node-api/package.json` carries the new `@duckdb/node-api` version, built on the new `DUCKDB_VERSION` pin (`src/version.ts`).
2. Re-copy `api/src` to `src/`, `api/test` to `test/`, `bindings/test` to `../node-bindings/test/`, `LICENSE` to both `LICENSE` files, and the bindings `duckdb.d.ts` to `node-bindings.d.ts`.
3. Run `bun run scripts/vendor-rewrite-bindings.ts` to rewrite the `@duckdb/node-bindings` imports to our bindings; it is idempotent.
4. Add any new bindings test file to `tests/official/bindings.test.ts`, and any new API test file to `tests/official/api.test.ts`.
5. Run `bun run gen:contract` to regenerate `src/bindings/generated/contract.ts` from `node-bindings.d.ts`.
6. Implement any newly added binding functions.
   Verify with `bun run test:official` and `bun run test:bindings`.
