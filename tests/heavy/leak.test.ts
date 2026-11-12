// Memory stays bounded over 2000 queries through the public API: resident set
// size levels off after a warm-up, and every native handle is freed again once
// its JavaScript object is collected.

import { expect, test } from "bun:test";
import { DuckDBInstance, diagnostics } from "../../src/neo.ts";

const WARM_UP = 200;
const QUERIES = 2000;
/** RSS growth allowed after the warm-up: 16 KiB per query would already exceed it. */
const MAX_GROWTH_BYTES = 32 * 1024 * 1024;

function settle(): number {
  Bun.gc(true);
  return process.memoryUsage.rss();
}

test(
  `RSS is bounded over ${QUERIES} queries and live handles return to their baseline`,
  async () => {
    const baseline = diagnostics().liveHandles;
    const instance = await DuckDBInstance.create(":memory:", { threads: "2", memory_limit: "256MB" });
    const connection = await instance.connect();
    await connection.run("CREATE TABLE t AS SELECT i, 'row ' || i AS s, i / 7 AS d FROM range(5000) r(i)");
    const statement = await connection.prepare("SELECT i, s FROM t WHERE i % $1 = 0");

    async function round(i: number): Promise<void> {
      const reader = await connection.runAndReadAll(
        `SELECT i, s, d, [i, i + 1] AS l FROM t WHERE i < ${(i % 50) * 20}`,
      );
      reader.getRowObjectsJson();
      statement.bindInteger(1, (i % 9) + 1);
      const result = await statement.stream();
      for await (const chunk of result) chunk.getRows();
    }

    for (let i = 0; i < WARM_UP; i++) await round(i);
    const before = settle();
    for (let i = 0; i < QUERIES; i++) await round(i);
    const after = settle();
    console.log(
      `RSS after warm-up ${(before / 2 ** 20).toFixed(1)} MiB, after ${QUERIES} queries ${(after / 2 ** 20).toFixed(1)} MiB`,
    );
    expect(after - before).toBeLessThan(MAX_GROWTH_BYTES);

    statement.destroySync();
    connection.closeSync();
    instance.closeSync();
    // Collected handles free their pointers from the FinalizationRegistry, which runs after a GC.
    for (let i = 0; i < 20 && JSON.stringify(diagnostics().liveHandles) !== JSON.stringify(baseline); i++) {
      settle();
      await Bun.sleep(10);
    }
    expect(diagnostics().liveHandles).toEqual(baseline);
  },
  5 * 60 * 1000,
);
