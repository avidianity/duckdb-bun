// The native-JS binding: a narrow API over the same bindings as the main entry,
// returning plain JavaScript values (README.md, "Native-JS binding").

export { DuckDBConnection } from "./connection.ts";
export { DuckDBInstance } from "./database.ts";
export { DuckDBError } from "./errors.ts";
export { Reader } from "./reader.ts";
export { PreparedStatement } from "./statement.ts";
export type { ColumnType, QueryResultShape } from "./types.ts";
export { DuckDBType } from "./types.ts";

import { version } from "../vendor/node-api/src/index.ts";

/** The linked libduckdb version, e.g. "v2.0.0". */
export function libraryVersion(): string {
  return version();
}
