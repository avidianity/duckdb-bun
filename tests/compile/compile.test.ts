// The headline proof: `bun build --compile` embeds libduckdb and the native shim,
// so the standalone binary queries DuckDB with nothing else on disk.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUCKDB_VERSION_TAG } from "../../src/version.ts";

const repoRoot = new URL("../../", import.meta.url).pathname;
const entry = join(repoRoot, "examples/compile-entry.ts");

test(
  "compiled standalone binary runs a DuckDB query with libduckdb embedded",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ddbun-compile-"));
    const bin = join(dir, "app");
    try {
      const build = await Bun.$`bun build ${entry} --compile --outfile ${bin}`.quiet().nothrow();
      expect(build.exitCode).toBe(0);

      // Run from a neutral cwd with LD_LIBRARY_PATH cleared so the .so can only
      // come from inside the executable, not the vendor dir or the environment.
      const run = await Bun.$`${bin}`.cwd(dir).env({ PATH: "/usr/bin:/bin" }).quiet().nothrow();
      expect(run.exitCode).toBe(0);
      const out = JSON.parse(run.stdout.toString().trim());
      expect(out).toMatchObject({
        version: DUCKDB_VERSION_TAG,
        v: "ok",
        n: "42",
        count: "3000",
        crashHandler: "installed",
      });
      // Both libraries were copied out of the executable, never loaded from the repository.
      for (const path of out.paths) expect(path.startsWith(repoRoot)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);
