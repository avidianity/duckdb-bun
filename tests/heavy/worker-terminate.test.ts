// Terminating a Worker that uses duckdb-bun while its native work is in flight
// must leave the process alive, stop every native thread the Worker started,
// free its database, and keep the main thread's database working
// (docs/adr/0008-a-worker-closes-its-context-in-an-n-api-cleanup-hook.md).
// Each round terminates one Worker during a long query, during a query that calls
// a JavaScript scalar function, during a streaming read, and while it loads the
// bindings, and lets one more Worker end on its own with its database open.
// The rounds run in a child process, so a crash is observable as a signal.

import { expect, test } from "bun:test";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "fixtures", "worker-terminate-child.ts");
const ROUNDS = 20;
const MODES = 5;
/**
 * OS threads the process may gain over the run without a leak, such as a JSC heap
 * helper. Every Worker database runs 3 DuckDB scheduler threads, so a database
 * left open by each of the 100 Workers would add about 300.
 */
const THREAD_SLACK = 32;

test(
  "terminated Workers free their native work and the process lives",
  async () => {
    const child = Bun.spawn([process.execPath, CHILD, String(ROUNDS)], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    const line = stdout.trim().split("\n").at(-1) ?? "";
    console.log(line);
    if (child.exitCode !== 0) console.log(stderr.slice(-4000));

    expect({ exitCode: child.exitCode, signal: child.signalCode }).toEqual({ exitCode: 0, signal: null });
    const result = JSON.parse(line);
    const { baseline, final } = result;
    expect(result.workers).toBe(ROUNDS * MODES + 1);
    expect(result.mainQueries).toBe(ROUNDS * MODES + 2);
    expect(final.counters.running).toBe(baseline.counters.running);
    expect(final.counters.jobs.completed).toBe(final.counters.jobs.started);
    expect(final.counters.jobs.inFlight).toBe(0);
    expect(final.counters.callbacks.completed).toBe(final.counters.callbacks.posted);
    expect(final.counters.callbacks.posted).toBeGreaterThan(baseline.counters.callbacks.posted);
    expect(final.threads - baseline.threads).toBeLessThanOrEqual(THREAD_SLACK);
  },
  5 * 60 * 1000,
);
