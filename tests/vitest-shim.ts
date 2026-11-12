// Stand-in for `vitest`, so the API and bindings suites (tests/api and
// tests/bindings), derived from the duckdb-node-neo Vitest suites, run under
// bun:test with their test code unchanged. They import this file in place of `vitest`.
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
      get(object, property) {
        if (SETTLE_MATCHERS.has(property)) {
          return Reflect.get(Reflect.apply(target, thisArg, [actual(), ...rest]) as object, property);
        }
        // Matchers check `this` is the real Expect object, not this proxy.
        const value = Reflect.get(object, property, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  },
}) as typeof bunExpect;
