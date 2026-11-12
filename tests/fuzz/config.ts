// Run settings shared by the fuzz targets.
//
//   FUZZ_RUNS  cases per property; the default keeps `bun run fuzz` well under
//              a minute. `bun run fuzz:nightly` raises it for the nightly CI run.
//   FC_SEED    every property starts from this seed. Without it, a run uses
//              FIXED_SEED, so a commit's result does not change across runs;
//              `bun run fuzz:nightly` draws a new one each night.
//   FC_PATH    with FC_SEED, replays one failing case and its shrink path.
//   FUZZ_TRACE a file that always holds the case about to run, for finding the
//              case behind a crash, which takes the process down before
//              fast-check can report it.
//
// A failure names the seed and path to replay, and the test to filter on.
import { writeFileSync } from "node:fs";
import fc from "fast-check";

export const DEFAULT_RUNS = 300;

function intFromEnv(name: string): number | undefined {
  const text = process.env[name];
  if (text === undefined || text === "") return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer, got ${JSON.stringify(text)}`);
  return value;
}

export const RUNS = intFromEnv("FUZZ_RUNS") ?? DEFAULT_RUNS;
export const FIXED_SEED = 20261112;
export const SEED = intFromEnv("FC_SEED") ?? FIXED_SEED;
const PATH = process.env.FC_PATH || undefined;

// Printed before any case runs, so a crash that takes the process down still
// leaves the seed to replay it with.
console.log(`fuzz: FC_SEED=${SEED} FUZZ_RUNS=${RUNS}${PATH ? ` FC_PATH=${PATH}` : ""}`);

/**
 * Runs `property` for `RUNS` cases (scaled by `weight`) from `SEED`. On failure,
 * rethrows fast-check's report, which holds the shrunk counterexample, with the
 * command that replays it.
 */
export async function check<T>(name: string, property: fc.IAsyncProperty<T>, weight = 1): Promise<void> {
  current = name;
  const numRuns = Math.max(1, Math.round(RUNS * weight));
  const details = await fc.check(property, { seed: SEED, path: PATH, numRuns, endOnFailure: PATH !== undefined });
  if (!details.failed) return;
  const replay = `FC_SEED=${details.seed} FC_PATH=${details.counterexamplePath} bun test tests/fuzz -t ${JSON.stringify(name)}`;
  throw new Error(`${fc.defaultReportMessage(details)}\n\nReplay: ${replay}`, {
    cause: details.errorInstance,
  });
}

const TRACE = process.env.FUZZ_TRACE || undefined;
let current = "";

/** Writes `data` to the FUZZ_TRACE file, if set, before an implementation runs it. */
export function trace(label: string, data: unknown): void {
  if (!TRACE) return;
  const text = JSON.stringify(data, (_key, value) =>
    typeof value === "bigint" ? `${value}n` : value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value,
  );
  writeFileSync(TRACE, `${current}: ${label}\n${text}\n`);
}
