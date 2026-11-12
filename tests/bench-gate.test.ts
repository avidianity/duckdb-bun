// The bench release gate (bench/gate.ts): limits, noise, floors and the event-loop gap.
import { expect, test } from "bun:test";
import { DEFAULT_LIMITS, judge, noise } from "../bench/gate.ts";

const base = { medianMs: 100, minMs: 90, runPeakRssMiB: 500, minRunPeakRssMiB: 450, metrics: {} };

test("ours within the limits passes", () => {
  const ours = { ...base, medianMs: 109, minMs: 98, runPeakRssMiB: 549 };
  expect(judge("s", base, ours, DEFAULT_LIMITS).failures).toEqual([]);
});

test("more than 10% slower on the median and the fastest run fails", () => {
  const verdict = judge("s", base, { ...base, medianMs: 111, minMs: 100 }, DEFAULT_LIMITS);
  expect(verdict.failures).toEqual(["11.0% slower (111.0 vs 100.0 ms), fastest run 11.1% slower, limit 10.0%"]);
});

test("a slower median with an equal fastest run passes: the runs fell into a slower mode", () => {
  expect(judge("s", base, { ...base, medianMs: 118, minMs: 91 }, DEFAULT_LIMITS).failures).toEqual([]);
});

test("more than 10% more peak RSS per run, on the median and the lowest run, fails", () => {
  const verdict = judge("s", base, { ...base, runPeakRssMiB: 600, minRunPeakRssMiB: 540 }, DEFAULT_LIMITS);
  expect(verdict.failures).toEqual([
    "20.0% more peak RSS per run (600 vs 500 MiB), lowest run 20.0% more, limit 10.0%",
  ]);
});

test("a higher median run peak with an equal lowest run passes: the allocator kept pages", () => {
  expect(judge("s", base, { ...base, runPeakRssMiB: 600, minRunPeakRssMiB: 455 }, DEFAULT_LIMITS).failures).toEqual([]);
});

test("differences under the floors never fail", () => {
  const small = { medianMs: 10, minMs: 9, runPeakRssMiB: 25, metrics: {} };
  const ours = { ...small, medianMs: 14, minMs: 13, runPeakRssMiB: 40 };
  expect(judge("s", small, ours, DEFAULT_LIMITS).failures).toEqual([]);
});

test("an event loop gap at the limit fails, and a child error fails", () => {
  expect(judge("s", base, { ...base, metrics: { maxGapMs: 50 } }, DEFAULT_LIMITS).failures).toEqual([
    "event loop gap 50.0 ms, limit 50 ms",
  ]);
  expect(judge("s", base, { ...base, medianMs: undefined, error: "boom" }, DEFAULT_LIMITS).failures).toEqual([
    "ours failed: boom",
  ]);
});

test("a limit below the measured noise rises to the noise", () => {
  const noisy = { ...base, noisePct: 20, memoryNoisePct: 15 };
  const within = { ...noisy, medianMs: 118, minMs: 106, runPeakRssMiB: 570 };
  expect(judge("s", noisy, within, DEFAULT_LIMITS).failures).toEqual([]);
  expect(judge("s", noisy, { ...noisy, medianMs: 125, minMs: 113 }, DEFAULT_LIMITS).failures).toEqual([
    "25.0% slower (125.0 vs 100.0 ms), fastest run 25.6% slower, limit 20.0%",
  ]);
});

test("noise is the spread of the per-child numbers over their mean", () => {
  expect(noise([90, 110])).toBe(20);
  expect(noise([100])).toBeUndefined();
});
