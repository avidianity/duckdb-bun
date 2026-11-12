// scripts/npm-registry.ts: a publish counts only once npm serves the version, which can take minutes.
import { describe, expect, test } from "bun:test";
import { awaitVersion, type Fetch, notServed, onRegistry, REGISTRY, WAIT_MINUTES } from "../scripts/npm-registry.ts";

const NAME = "@avidian/duckdb-bun-linux-x64";

/** A registry that serves `served` versions after `delay` lookups of each, and answers 404 otherwise. */
function registry(served: string[], delay = 0): { fetch: Fetch; urls: string[] } {
  const urls: string[] = [];
  const seen = new Map<string, number>();
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      const version = url.slice(url.lastIndexOf("/") + 1);
      const count = (seen.get(version) ?? 0) + 1;
      seen.set(version, count);
      return new Response(null, { status: served.includes(version) && count > delay ? 200 : 404 });
    },
  };
}

/** A clock that only moves when the wait sleeps. */
function clock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

describe("onRegistry", () => {
  test("asks the registry for the scoped name, escaped, and the version", async () => {
    const { fetch, urls } = registry(["1.0.0"]);
    expect(await onRegistry(NAME, "1.0.0", fetch)).toBe(true);
    expect(await onRegistry(NAME, "1.0.1", fetch)).toBe(false);
    expect(urls[0]).toBe(`${REGISTRY}/@avidian%2fduckdb-bun-linux-x64/1.0.0`);
  });

  test("an answer other than 200 or 404 is an error", async () => {
    const failing: Fetch = async () => new Response(null, { status: 503 });
    await expect(onRegistry(NAME, "1.0.0", failing)).rejects.toThrow(`${REGISTRY} answered 503 for ${NAME}@1.0.0`);
  });
});

describe("awaitVersion", () => {
  test("the default wait outlasts the 7 min 15 s npm took to serve 1.0.0", () => {
    expect(WAIT_MINUTES * 60).toBeGreaterThan(2 * (7 * 60 + 15));
  });

  test("true once npm serves the version, polling at the interval", async () => {
    const time = clock();
    const { fetch } = registry(["1.0.0"], 2);
    const served = await awaitVersion(NAME, "1.0.0", { fetch, timeoutMs: 60_000, intervalMs: 7_000, ...time });
    expect(served).toBe(true);
    expect(time.sleeps).toEqual([7_000, 7_000]);
  });

  test("a version served after more than 7 minutes still counts", async () => {
    const time = clock();
    const { fetch } = registry(["1.0.0"], 44);
    expect(await awaitVersion(NAME, "1.0.0", { fetch, ...time })).toBe(true);
    expect(time.now()).toBe(440_000);
  });

  test("false when npm does not serve the version before the timeout", async () => {
    const time = clock();
    const { fetch, urls } = registry([]);
    expect(await awaitVersion(NAME, "1.0.0", { fetch, timeoutMs: 30_000, intervalMs: 10_000, ...time })).toBe(false);
    expect(urls).toHaveLength(4);
    expect(time.now()).toBe(30_000);
  });
});

test("notServed names the wait, the package page and the re-run", () => {
  const message = notServed(NAME, "1.0.0");
  expect(message).toContain(`did not serve it within ${WAIT_MINUTES} minutes`);
  expect(message).toContain(`https://www.npmjs.com/package/${NAME}`);
  expect(message).toContain("versions already on npm are skipped");
});
