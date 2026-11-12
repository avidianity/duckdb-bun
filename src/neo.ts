// Public entry for the drop-in `@duckdb/node-api` replacement. Re-exports the full
// TypeScript API in src/api (running over our bun:ffi bindings), so:
//
//   import { DuckDBInstance } from "@avidian/duckdb-bun";
//
// behaves like `@duckdb/node-api`, with the same classes and value objects, but
// embeds libduckdb, so `bun build --compile` yields a self-contained binary.
//
// It adds diagnostics(), DUCKDB_VERSION and the "duckdb-bun:call" tracing channel (README.md).
// The narrow, native-JS binding is still available at `@avidian/duckdb-bun/native-js`.
export * from "./api/index.ts";
export { default } from "./api/index.ts";
export { type Diagnostics, diagnostics } from "./bindings/runtime/diagnostics.ts";
export type { CallContext } from "./bindings/runtime/trace.ts";
/** The DuckDB version this package bundles, such as "2.0.0". */
export { DUCKDB_VERSION } from "./version.ts";
