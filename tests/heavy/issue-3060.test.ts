// A query that runs out of memory must reject with DuckDB's Out of Memory error
// and leave the process alive (duckdb-node-neo #3060; the query is the
// reproduction from duckdb/duckdb#26441, with memory_limit 2GB and 4 threads).
// Each implementation runs in its own child process, so an abort is observable.
// The official binding's outcome is recorded in the test output, not asserted.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "fixtures", "issue-3060-child.ts");
const temp = mkdtempSync(join(tmpdir(), "duckdb-bun-3060-"));

afterAll(() => rmSync(temp, { recursive: true, force: true }));

async function run(which: "ours" | "official") {
  const child = Bun.spawn([process.execPath, CHILD, which, join(temp, which)], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
  const line = stdout.trim().split("\n").at(-1) ?? "";
  return {
    exitCode: child.exitCode,
    signal: child.signalCode,
    result: line.startsWith("{") ? JSON.parse(line) : null,
    stderr,
  };
}

test(
  "the duckdb/duckdb#26441 query rejects with Out of Memory and the process lives",
  async () => {
    const official = await run("official");
    console.log(`official @duckdb/node-api: ${JSON.stringify({ ...official, stderr: official.stderr.slice(-2000) })}`);
    const ours = await run("ours");
    expect({ exitCode: ours.exitCode, signal: ours.signal }).toEqual({ exitCode: 0, signal: null });
    expect(ours.result?.outcome).toBe("error");
    expect(ours.result?.message).toMatch(/^Out of Memory Error: /);
  },
  10 * 60 * 1000,
);
