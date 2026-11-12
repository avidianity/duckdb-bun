// The bench release gate (bench/gate.ts): the paired significance test, the floors and the event-loop gap.
import { expect, test } from "bun:test";
import { DEFAULT_LIMITS, type GateInput, judge, signedRankGreater } from "../bench/gate.ts";
import { SCENARIOS } from "../bench/scenarios.ts";

/** Runs in pair order: run k of baseline and run k of ours ran seconds apart. */
function input(runsMs: number[], runPeaksMiB: number[] = runsMs.map(() => 500)): GateInput {
  return { runsMs, runPeaksMiB, metrics: {} };
}

const steady = [100, 101, 99, 100, 102, 98, 100, 101, 99, 100];
const times = (factor: number) => steady.map((value) => value * factor);

test("the signed-rank test gives exact p-values, with zeros dropped and tied ranks averaged", () => {
  expect(signedRankGreater([1, 2, 3])).toBe(1 / 8);
  // Ranks 1, 2, 3 with positive ranks 1 and 3: 3 of the 8 sign assignments reach a sum of 4.
  expect(signedRankGreater([1, -2, 3])).toBe(3 / 8);
  expect(signedRankGreater([-1, -2, -3])).toBe(1);
  expect(signedRankGreater([1, 1, 1])).toBe(1 / 8);
  expect(signedRankGreater([0, 1])).toBe(1 / 2);
  expect(signedRankGreater([0, 0])).toBe(1);
  expect(signedRankGreater(Array.from({ length: 10 }, (_, i) => i + 1))).toBe(1 / 1024);
});

test("within the limit passes, and 20% slower with low noise fails", () => {
  expect(judge("s", input(steady), input(times(1.05)), DEFAULT_LIMITS).failures).toEqual([]);
  const verdict = judge("s", input(steady), input(times(1.2)), DEFAULT_LIMITS);
  expect(verdict.pairs).toBe(10);
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

test("a slow spell that slows both runs of a pair passes", () => {
  // The macOS runner on 2026-11-12: runs of one package went from about 140 ms to 300 to 520 ms for a few
  // seconds. Paired children see the spell together.
  const spell = [1, 1, 1, 2.1, 3.7, 3.4, 2.4, 1, 1, 1];
  const baseline = spell.map((factor, k) => (steady[k] ?? 100) * factor);
  const ours = spell.map((factor, k) => (steady[(k + 3) % 10] ?? 100) * factor * 1.04);
  expect(judge("s", input(baseline), input(ours), DEFAULT_LIMITS).failures).toEqual([]);
});

test("a consistent excess fails even inside a slow spell", () => {
  const spell = [1, 1, 1, 2.1, 3.7, 3.4, 2.4, 1, 1, 1];
  const baseline = spell.map((factor, k) => (steady[k] ?? 100) * factor);
  const ours = baseline.map((value) => value * 1.3);
  expect(judge("s", input(baseline), input(ours), DEFAULT_LIMITS).failures[0]).toStartWith("30.0% slower");
});

test("runs that do not pair up fail", () => {
  expect(judge("s", input(steady), input(steady.slice(1)), DEFAULT_LIMITS).failures).toEqual([
    "unpaired runs: 9 of ours and 10 of baseline; run k of each must be pair k",
  ]);
});

test("every scenario has enough pairs for its signed-rank test to reach the significance level", () => {
  for (const scenario of SCENARIOS) {
    const pairs = 2 * scenario.rounds;
    expect({ scenario: scenario.name, reachable: 0.5 ** pairs < DEFAULT_LIMITS.alpha }).toEqual({
      scenario: scenario.name,
      reachable: true,
    });
  }
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
