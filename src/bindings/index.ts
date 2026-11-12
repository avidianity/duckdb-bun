// Our reimplementation of the `@duckdb/node-bindings` contract
// (vendor/node-api/node-bindings.d.ts) over the libduckdb C API, through bun:ffi
// and the Rust shim. The vendored `@duckdb/node-api` imports it as a default
// (`import duckdb from ...`), a namespace and by name, so it exports all three.
// The default export is a namespace, so `duckdb.Database` and the other contract
// types resolve through it as they do through the official module.
import * as duckdb from "./api/index.ts";

export * from "./api/index.ts";
export default duckdb;
