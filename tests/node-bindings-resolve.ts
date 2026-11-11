// Resolves `@duckdb/node-bindings` to our src/bindings/ for CommonJS resolution
// (`require()`, `require.resolve()`, `createRequire(...).resolve()`) made from the
// vendored @duckdb/node-bindings suite, vendor/node-bindings/test/.
//
// tests/preload.ts covers the suite's ESM `import ... from '@duckdb/node-bindings'`
// by rewriting the source at load time. Two cases never pass through that rewrite:
// worker_threads.test.ts calls `createRequire(import.meta.url).resolve(...)`, and
// scalar_function_exit.test.ts spawns `process.execPath` (bun) on
// fixtures/scalarFunctionExit.cjs, which calls `require(...)`. Both go through
// `Module._resolveFilename`, which Bun lets us override. A Bun.plugin onResolve
// does not fire for a bare specifier that fails normal resolution, so it cannot
// do this job.
//
// tests/preload.ts imports this file for the test process and puts it on
// BUN_OPTIONS so every bun process the tests spawn preloads it as well.

import Module from "node:module";
import { join } from "node:path";

// DUCKDB_BUN_NEXT=1 points the vendored suites at the bindings being rebuilt on
// the Rust shim (src/bindings/next.ts) until they replace src/bindings/index.ts.
const BINDINGS = join(
  import.meta.dir,
  process.env.DUCKDB_BUN_NEXT === "1" ? "../src/bindings/next.ts" : "../src/bindings/index.ts",
);
const VENDOR_BINDINGS_TEST = /[\\/]vendor[\\/]node-bindings[\\/]test[\\/]/;

type ResolveFilename = (request: string, parent: { filename?: string } | undefined, ...rest: unknown[]) => string;
const ModuleInternals = Module as unknown as { _resolveFilename: ResolveFilename };
const resolveFilename = ModuleInternals._resolveFilename;

ModuleInternals._resolveFilename = function (this: unknown, request, parent, ...rest) {
  if (request === "@duckdb/node-bindings" && VENDOR_BINDINGS_TEST.test(parent?.filename ?? "")) {
    return BINDINGS;
  }
  return resolveFilename.call(this, request, parent, ...rest);
};
