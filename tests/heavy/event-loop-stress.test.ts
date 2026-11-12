// The JS thread never waits for a query: while a multi-second query and many
// small ones run, a 10 ms timer keeps firing on time.
//
// The official @duckdb/node-api runs the same load first, under the same
// conditions, and its numbers are printed next to ours for comparison only.

import { expect, test } from "bun:test";
import { availableParallelism } from "node:os";
import * as ours from "../../src/neo.ts";
import { assertRealOfficialBinding } from "../official-binding.ts";

const TICK_MS = 10;
// Most gaps stay near the tick. A busy machine still preempts the JS thread now and then: the 3-vCPU
// macOS CI runner showed single gaps of 118 to 202 ms among about 1000 ticks, with no change to the
// binding. So the 99th percentile carries the timing claim, and the largest gap only has to stay far
// below the long query, which a blocked JS thread would show as one gap as long as the query.
const P99_GAP_MS = 50;
const MAX_GAP_MS = 1000;
// DuckDB gets every core but one, so the JS thread always has a core to run on.
// With more busy threads than cores, the OS scheduler delays the timer too: a
// 3-core CI runner with 4 DuckDB threads showed 118 ms gaps, where a 12-core
// machine showed 12 ms.
const THREADS = String(Math.max(1, availableParallelism() - 1));

type Api = Pick<typeof ours, "DuckDBInstance">;

async function measure(api: Api) {
  const instance = await api.DuckDBInstance.create(":memory:", { threads: THREADS });
  const long = await instance.connect();
  const short = await instance.connect();

  let last = performance.now();
  const gaps: number[] = [];
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
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
  long.closeSync();
  short.closeSync();
  instance.closeSync();

  const sorted = gaps.toSorted((a, b) => a - b);
  return {
    rows: reader.currentRowCount,
    elapsed,
    count,
    ticks: gaps.length,
    p99Gap: sorted[Math.floor(sorted.length * 0.99)] ?? Number.POSITIVE_INFINITY,
    maxGap: sorted.at(-1) ?? Number.POSITIVE_INFINITY,
  };
}

function describe(name: string, m: Awaited<ReturnType<typeof measure>>): string {
  return `${name}: long query ${m.elapsed.toFixed(0)} ms, ${m.count} short queries, ${m.ticks} ticks, p99 gap ${m.p99Gap.toFixed(1)} ms, max gap ${m.maxGap.toFixed(1)} ms`;
}

test(
  `a 10 ms timer keeps firing while queries run: p99 gap under ${P99_GAP_MS} ms, none near the query`,
  async () => {
    assertRealOfficialBinding();
    const official = (await import("@duckdb/node-api")) as unknown as Api;
    console.log(describe("official @duckdb/node-api", await measure(official)));
    const result = await measure(ours);
    console.log(describe("ours", result));

    expect(result.rows).toBe(1);
    expect(result.elapsed).toBeGreaterThan(2 * MAX_GAP_MS);
    expect(result.p99Gap).toBeLessThan(P99_GAP_MS);
    expect(result.maxGap).toBeLessThan(MAX_GAP_MS);
  },
  4 * 60 * 1000,
);
