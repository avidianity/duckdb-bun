// The bench release gate (bench/gate.ts): the significance test, the floors and the event-loop gap.
// The run lists marked "CI" are real runs from GitHub-hosted runners on 2026-11-12.
import { expect, test } from "bun:test";
import { DEFAULT_LIMITS, type GateInput, judge, mannWhitneyGreater } from "../bench/gate.ts";

function input(runsMs: number[], runPeaksMiB: number[] = runsMs.map(() => 500)): GateInput {
  return { runsMs, runPeaksMiB, metrics: {} };
}

const steady = [100, 101, 99, 100, 102, 98, 100, 101, 99, 100];
const times = (factor: number) => steady.map((value) => value * factor);

test("the Mann-Whitney test separates shifted samples and not equal ones", () => {
  expect(mannWhitneyGreater(times(1.5), steady)).toBeLessThan(0.001);
  expect(mannWhitneyGreater(steady, steady)).toBeGreaterThan(0.4);
  expect(mannWhitneyGreater(steady, times(1.5))).toBeGreaterThan(0.999);
});

test("within the limit passes, and 20% slower with low noise fails", () => {
  expect(judge("s", input(steady), input(times(1.05)), DEFAULT_LIMITS).failures).toEqual([]);
  const verdict = judge("s", input(steady), input(times(1.2)), DEFAULT_LIMITS);
  expect(verdict.failures).toHaveLength(1);
  expect(verdict.failures[0]).toStartWith("20.0% slower (120.0 vs 100.0 ms), more than 10% at p = ");
});

test("20% more peak RSS per run with low noise fails", () => {
  const peaks = [500, 505, 498, 502, 500, 499, 501, 503, 497, 500];
  const verdict = judge(
    "s",
    input(steady, peaks),
    input(
      steady,
      peaks.map((v) => v * 1.2),
    ),
    DEFAULT_LIMITS,
  );
  expect(verdict.failures).toHaveLength(1);
  expect(verdict.failures[0]).toStartWith("20.0% more peak RSS per run (600 vs 500 MiB), more than 10% at p = ");
});

test("CI Linux parquet-write: runs in two speed modes for both packages pass", () => {
  const official = [116, 116, 138, 113, 119, 111, 141, 112, 138, 138];
  const ours = [145, 133, 138, 111, 139, 120, 137, 139, 143, 139];
  expect(judge("parquet-write", input(official), input(ours), DEFAULT_LIMITS).failures).toEqual([]);
});

test("CI macOS ingest-csv: a 17% median gap inside a 144 to 265 ms spread passes", () => {
  const official = [186, 200, 201, 179, 199, 265, 177, 180, 196, 144];
  const ours = [248, 222, 238, 226, 265, 220, 239, 169, 183, 202];
  expect(judge("ingest-csv", input(official), input(ours), DEFAULT_LIMITS).failures).toEqual([]);
});

test("differences under the floors never fail", () => {
  const small = [10, 10.1, 9.9, 10, 10.2, 9.8, 10, 10.1, 9.9, 10];
  const verdict = judge(
    "s",
    input(
      small,
      small.map(() => 25),
    ),
    input(
      small.map((v) => v * 1.4),
      small.map(() => 40),
    ),
    DEFAULT_LIMITS,
  );
  expect(verdict.failures).toEqual([]);
});

test("a p99 gap or a blocked event loop at the limit fails, and a child error fails", () => {
  const gaps = (metrics: Record<string, number>) =>
    judge("s", input(steady), { ...input(steady), metrics }, DEFAULT_LIMITS);
  expect(gaps({ p99GapMs: 50, maxGapMs: 60 }).failures).toEqual(["event loop p99 gap 50.0 ms, limit 50 ms"]);
  expect(gaps({ p99GapMs: 12, maxGapMs: 1000 }).failures).toEqual(["event loop blocked for 1000.0 ms, limit 1000 ms"]);
  expect(judge("s", input(steady), { ...input([]), error: "boom" }, DEFAULT_LIMITS).failures).toEqual([
    "ours failed: boom",
  ]);
});

test("CI macOS event-loop-lag: a single 85 ms gap with an 18.6 ms median p99 passes", () => {
  expect(
    judge(
      "event-loop-lag",
      input(steady),
      { ...input(steady), metrics: { p99GapMs: 18.6, maxGapMs: 85.2 } },
      DEFAULT_LIMITS,
    ).failures,
  ).toEqual([]);
});
