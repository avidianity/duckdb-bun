// Public entry for the drop-in `@duckdb/node-api` replacement. Re-exports the full
// vendored official TypeScript API (running over our bun:ffi bindings), so:
//
//   import { DuckDBInstance } from "@avidian/duckdb-bun";
//
// behaves like `@duckdb/node-api`, with the same classes and value objects, but
// embeds libduckdb, so `bun build --compile` yields a self-contained binary.
//
// It adds diagnostics() and the "duckdb-bun:call" tracing channel (README.md).
// The narrow, native-JS binding is still available at `@avidian/duckdb-bun/native-js`.
export * from "../vendor/node-api/src/index.ts";
export { default } from "../vendor/node-api/src/index.ts";
export { type Diagnostics, diagnostics } from "./bindings/runtime/diagnostics.ts";
export type { CallContext } from "./bindings/runtime/trace.ts";
