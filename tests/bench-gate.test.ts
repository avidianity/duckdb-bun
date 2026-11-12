// The bench release gate (bench/gate.ts): limits, floors and the event-loop gap.
import { expect, test } from "bun:test";
import { DEFAULT_LIMITS, judge, noise } from "../bench/gate.ts";

const base = { medianMs: 100, peakRssMiB: 500, metrics: {} };

test("ours within the limits passes", () => {
  expect(judge("s", base, { ...base, medianMs: 109, peakRssMiB: 549 }, DEFAULT_LIMITS).failures).toEqual([]);
});

test("more than 10% slower fails", () => {
  const verdict = judge("s", base, { ...base, medianMs: 111 }, DEFAULT_LIMITS);
  expect(verdict.failures).toEqual(["11.0% slower (111.0 vs 100.0 ms), limit 10%"]);
});

test("more than 10% more peak RSS fails", () => {
  const verdict = judge("s", base, { ...base, peakRssMiB: 600 }, DEFAULT_LIMITS);
  expect(verdict.failures).toEqual(["20.0% more peak RSS (600 vs 500 MiB), limit 10%"]);
});

test("differences under the floors never fail", () => {
  const small = { medianMs: 10, peakRssMiB: 25, metrics: {} };
  expect(judge("s", small, { ...small, medianMs: 14, peakRssMiB: 40 }, DEFAULT_LIMITS).failures).toEqual([]);
});

test("an event loop gap at the limit fails, and a child error fails", () => {
  expect(judge("s", base, { ...base, metrics: { maxGapMs: 50 } }, DEFAULT_LIMITS).failures).toEqual([
    "event loop gap 50.0 ms, limit 50 ms",
  ]);
  expect(judge("s", base, { ...base, medianMs: undefined, error: "boom" }, DEFAULT_LIMITS).failures).toEqual([
    "ours failed: boom",
  ]);
});

test("noise is the spread of the child medians over their mean", () => {
  expect(noise([90, 110])).toBe(20);
  expect(noise([100])).toBeUndefined();
});
