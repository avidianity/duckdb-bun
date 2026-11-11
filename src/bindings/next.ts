// The @duckdb/node-bindings contract on the Rust shim runtime, being built
// family by family. It replaces src/bindings/index.ts at the cutover; until then
// the vendored suites run against it with DUCKDB_BUN_NEXT=1.
import * as database from "./api/database.ts";
import * as contract from "./generated/contract.ts";

export * from "./api/database.ts";
export * from "./generated/contract.ts";

const duckdb = { ...contract, ...database };
export default duckdb;
