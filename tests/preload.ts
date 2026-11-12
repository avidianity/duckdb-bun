// Test preload: lets the vendored official suites (vendor/node-api/test and
// vendor/node-bindings/test) run unmodified on disk.
//
// `bun test` hard-remaps `vitest` to bun:test (which has no `assert` export)
// before tsconfig paths or plugin onResolve run, so the only way to redirect it is
// to rewrite the specifier in the source at load time; Bun then never sees
// `vitest`. The same onLoad rewrite points the suites' ESM
// `import ... from '@duckdb/node-bindings'` at our bindings. Scoped to the
// vendored test directories.
//
// CommonJS resolution of `@duckdb/node-bindings` from the bindings suite, in this
// process and in the bun processes it spawns, is handled by
// tests/node-bindings-resolve.ts; see that file.
//
// The vendored SRC's `@duckdb/node-bindings` import is already rewritten to our
// bun:ffi bindings on disk by scripts/vendor-rewrite-bindings.ts, so no alias is
// needed for it here. That on-disk rewrite is also what makes the published
// package a plugin-free drop-in.

import { join } from "node:path";
import { plugin } from "bun";
import "./node-bindings-resolve.ts";

const VITEST_SHIM = join(import.meta.dir, "./vitest-shim.ts");
const BINDINGS = join(import.meta.dir, "../src/bindings/index.ts");
const BINDINGS_RESOLVE = join(import.meta.dir, "./node-bindings-resolve.ts");
const VENDOR_TEST = /\/vendor\/node-(api|bindings)\/test\/.*\.ts$/;

// BUN_OPTIONS splits on whitespace and does not honor quotes, so a path with
// whitespace would be silently mangled into a broken flag.
if (/\s/.test(BINDINGS_RESOLVE)) {
  throw new Error(
    `tests/preload.ts: cannot pass a path containing whitespace through BUN_OPTIONS: ${BINDINGS_RESOLVE}`,
  );
}
const childPreload = `--preload=${BINDINGS_RESOLVE}`;
const bunOptions = process.env.BUN_OPTIONS ?? "";
if (!bunOptions.split(/\s+/).includes(childPreload)) {
  process.env.BUN_OPTIONS = `${bunOptions} ${childPreload}`.trim();
}

plugin({
  name: "duckdb-bun-vitest-alias",
  setup(build) {
    build.onLoad({ filter: VENDOR_TEST }, async (args) => {
      const source = await Bun.file(args.path).text();
      const contents = source
        .replace(/from ['"]vitest['"]/g, `from ${JSON.stringify(VITEST_SHIM)}`)
        .replace(/from ['"]@duckdb\/node-bindings['"]/g, `from ${JSON.stringify(BINDINGS)}`);
      return { contents, loader: "ts" };
    });
  },
});
