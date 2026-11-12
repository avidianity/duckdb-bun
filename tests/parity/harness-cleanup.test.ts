// The parity harness removes every directory it creates. `bun test` does not emit
// the process "exit" event, so a cleanup hooked there never ran and each test
// process left its `<shared>` directories behind in the temp directory.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");

test("a parity test file leaves no directories in the temp directory", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "duckdb-bun-harness-cleanup-")));
  try {
    const child = Bun.spawn([process.execPath, "test", "tests/parity/cache.test.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, TMPDIR: temp },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode: await child.exited, stderr: stderr.includes(" 0 fail") }).toEqual({ exitCode: 0, stderr: true });
    expect(readdirSync(temp).filter((name) => name.startsWith("duckdb-bun-parity-"))).toEqual([]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 120_000);
