// Runs the fuzz targets in tests/fuzz/ at nightly length, one file at a time, for the scheduled CI run.
//
//   bun run fuzz:nightly           FUZZ_RUNS=10000 unless FUZZ_RUNS is set; a new FC_SEED unless FC_SEED is set
//
// Each file writes the case it is about to run to fuzz-trace/<file>.txt (FUZZ_TRACE), so a crash that takes the
// process down before fast-check can report it still leaves the case behind. Exits 1 when any file fails.
import { mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const NIGHTLY_RUNS = 10_000;
const TRACE_DIR = join(ROOT, "fuzz-trace");

const files = readdirSync(join(ROOT, "tests/fuzz"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
mkdirSync(TRACE_DIR, { recursive: true });

// The pull request runs use a fixed seed (tests/fuzz/config.ts); the nightly run explores a new one.
const seed = process.env.FC_SEED || String((Math.random() * 2 ** 31) | 0);
console.log(`fuzz:nightly: FC_SEED=${seed}`);

let failed = 0;
for (const file of files) {
  const env = {
    ...process.env,
    FUZZ_RUNS: process.env.FUZZ_RUNS || String(NIGHTLY_RUNS),
    FC_SEED: seed,
    FUZZ_TRACE: join(TRACE_DIR, `${basename(file, ".test.ts")}.txt`),
  };
  const run = Bun.spawnSync([process.execPath, "test", join("tests/fuzz", file)], {
    cwd: ROOT,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!run.success) {
    failed += 1;
    const how = run.signalCode ? `signal ${run.signalCode}` : `exit ${run.exitCode}`;
    console.error(`${file} failed (${how}); last case: ${env.FUZZ_TRACE}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
