// The official @duckdb/node-api must load its own N-API binding whenever a test or the bench compares
// ours with it. An alias that sends its `require("@duckdb/node-bindings")` to src/bindings/ (a tsconfig
// `paths` entry did, until 2026-11-12) makes every such comparison compare ours with ours, silently.

import { createRequire } from "node:module";
import { sep } from "node:path";

/** Where the official package's `@duckdb/node-bindings` import resolves in this process. */
export function officialBindingPath(): string {
  const officialRequire = createRequire(Bun.resolveSync("@duckdb/node-api", import.meta.dir));
  return officialRequire.resolve("@duckdb/node-bindings");
}

/** Throws unless the official package resolves the real @duckdb/node-bindings from node_modules. */
export function assertRealOfficialBinding(): void {
  const path = officialBindingPath();
  if (!path.includes(`${sep}node_modules${sep}`) || !path.includes(`@duckdb${sep}node-bindings${sep}`)) {
    throw new Error(`the official @duckdb/node-api resolves @duckdb/node-bindings to ${path}, not its own package`);
  }
}
