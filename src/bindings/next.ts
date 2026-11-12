// The @duckdb/node-bindings contract on the Rust shim runtime, being built
// family by family. It replaces src/bindings/index.ts at the cutover; until then
// the vendored suites run against it with DUCKDB_BUN_NEXT=1.
import * as appender from "./api/appender.ts";
import * as dataChunk from "./api/data-chunk.ts";
import * as database from "./api/database.ts";
import * as datetime from "./api/datetime.ts";
import * as logicalTypes from "./api/logical-types.ts";
import * as query from "./api/query.ts";
import * as scalarFunction from "./api/scalar-function.ts";
import * as values from "./api/values.ts";
import * as vector from "./api/vector.ts";
import * as contract from "./generated/contract.ts";

export * from "./api/appender.ts";
export * from "./api/data-chunk.ts";
export * from "./api/database.ts";
export * from "./api/datetime.ts";
export * from "./api/logical-types.ts";
export * from "./api/query.ts";
export * from "./api/scalar-function.ts";
export * from "./api/values.ts";
export * from "./api/vector.ts";
export * from "./generated/contract.ts";

const duckdb = {
  ...contract,
  ...database,
  ...query,
  ...datetime,
  ...logicalTypes,
  ...values,
  ...appender,
  ...dataChunk,
  ...vector,
  ...scalarFunction,
};
export default duckdb;
