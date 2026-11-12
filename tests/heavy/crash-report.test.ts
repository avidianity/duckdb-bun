// The fatal-signal crash report (native/ABI.md "Diagnostics"): a crash on the JS
// thread or on a native thread prints the header, the ring buffer of recent
// binding events with redacted SQL, and a backtrace, then the process still dies
// of the original signal. Each case runs in a child process.

import { expect, test } from "bun:test";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "fixtures", "crash-child.ts");

async function crash(kind: number, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, CHILD, String(kind)], {
    env: { ...process.env, DUCKDB_BUN_TRACE_SQL: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
  return { stdout, stderr, exitCode: child.exitCode, signal: child.signalCode };
}

test("a null dereference on the JS thread prints the report and dies of SIGSEGV", async () => {
  const { stdout, stderr, exitCode } = await crash(1);
  expect(stdout).not.toContain("the crash hook returned");
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/\[duckdb-bun\] fatal signal (11 \(SIGSEGV\)|10 \(SIGBUS\)) on thread js/);
  expect(stderr).toMatch(/\[duckdb-bun\] package \S+, duckdb v2\.0\.0, bun \S+, shim \S+/);
  expect(stderr).toContain("[duckdb-bun] last binding events, oldest first:");
  expect(stderr).toContain(`text="SELECT 'plain-text' AS plain"`);
  expect(stderr).toContain(`text="SET s3_secret_access_key = '<redacted>'"`);
  expect(stderr).not.toContain("do-not-print-me");
  expect(stderr).toContain("[duckdb-bun] native backtrace:");
});

test("a stack overflow on a native thread is reported on its alternate signal stack", async () => {
  const { stderr, exitCode } = await crash(3);
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/\[duckdb-bun\] fatal signal \d+ \(SIG[A-Z]+\) on thread /);
  expect(stderr).toContain("[duckdb-bun] native backtrace:");
});

test("DUCKDB_BUN_CRASH_HANDLER=0 leaves the handler uninstalled", async () => {
  const { stderr, exitCode } = await crash(1, { DUCKDB_BUN_CRASH_HANDLER: "0" });
  expect(exitCode).not.toBe(0);
  expect(stderr).not.toContain("[duckdb-bun] fatal signal");
});
