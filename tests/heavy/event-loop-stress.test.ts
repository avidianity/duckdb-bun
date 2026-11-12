// The JS thread never waits for a query: while a multi-second query and many
// small ones run, a 10 ms timer keeps firing on time.

import { expect, test } from "bun:test";
import { DuckDBInstance } from "../../src/neo.ts";

const TICK_MS = 10;
const MAX_GAP_MS = 50;

test(
  `a 10 ms timer never waits more than ${MAX_GAP_MS} ms while queries run`,
  async () => {
    const instance = await DuckDBInstance.create(":memory:", { threads: "4" });
    const long = await instance.connect();
    const short = await instance.connect();

    let last = performance.now();
    let maxGap = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, TICK_MS);

    const started = performance.now();
    // About 5 seconds on a CI runner; the exact length does not matter, only that it spans many ticks.
    const longQuery = long.runAndReadAll("SELECT sum(hash(i)) FROM range(1_500_000_000) t(i)");
    const shortQueries = (async () => {
      let count = 0;
      while (performance.now() - started < 2000) {
        await short.runAndReadAll("SELECT count(*) FROM range(100000)");
        count++;
      }
      return count;
    })();
    const [reader, count] = await Promise.all([longQuery, shortQueries]);
    const elapsed = performance.now() - started;
    clearInterval(timer);

    console.log(
      `long query ${elapsed.toFixed(0)} ms, ${count} short queries, ${ticks} ticks, max gap ${maxGap.toFixed(1)} ms`,
    );
    expect(reader.currentRowCount).toBe(1);
    expect(elapsed).toBeGreaterThan(1000);
    expect(maxGap).toBeLessThan(MAX_GAP_MS);

    long.closeSync();
    short.closeSync();
    instance.closeSync();
  },
  2 * 60 * 1000,
);
