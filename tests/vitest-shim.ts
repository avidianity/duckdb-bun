// Stand-in for `vitest` so the vendored official suites (vendor/node-api/test and
// vendor/node-bindings/test) run unmodified under bun:test. tests/preload.ts
// rewrites their `vitest` import to this file at load time.
//
// Exports exactly what those suites import from `vitest`. The runner primitives
// come from bun:test; vitest's `suite` is its alias of `describe`, which bun:test
// does not export under that name. vitest's `assert` is chai's `assert`, and
// bun:test has no `assert` export, so it comes from chai itself.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

export { assert } from "chai";
export { afterAll, beforeAll, describe, describe as suite, expect, test };
