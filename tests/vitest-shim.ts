// Stand-in for `vitest` so the vendored official suites (vendor/node-api/test and
// vendor/node-bindings/test) run unmodified under bun:test. tests/preload.ts
// rewrites their `vitest` import to this file at load time.
//
// Exports exactly what those suites import from `vitest`. The runner primitives
// come from bun:test; vitest's `suite` is its alias of `describe`, which bun:test
// does not export under that name. vitest's `assert` is chai's `assert`, and
// bun:test has no `assert` export, so it comes from chai itself.
//
// `expect` differs in one way the suites rely on: vitest's `.rejects` and
// `.resolves` accept a function and call it to get the promise
// (`expect(async () => ...).rejects`), while bun:test requires the promise.
import { afterAll, beforeAll, expect as bunExpect, describe, test } from "bun:test";

export { assert } from "chai";
export { afterAll, beforeAll, describe, describe as suite, test };

const SETTLE_MATCHERS = new Set<PropertyKey>(["rejects", "resolves"]);

export const expect = new Proxy(bunExpect, {
  apply(target, thisArg, args: unknown[]) {
    const [actual, ...rest] = args;
    const matchers = Reflect.apply(target, thisArg, args) as object;
    if (typeof actual !== "function") return matchers;
    return new Proxy(matchers, {
      get(object, property, receiver) {
        if (SETTLE_MATCHERS.has(property)) {
          return Reflect.get(Reflect.apply(target, thisArg, [actual(), ...rest]) as object, property);
        }
        return Reflect.get(object, property, receiver);
      },
    });
  },
}) as typeof bunExpect;
