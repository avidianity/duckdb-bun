// The release gate over a bench run: ours may be at most `maxSlowerPct` slower and use at most
// `maxMemoryPct` more peak RSS per run than the baseline, on every scenario. The baseline is the @duckdb/node-api
// reference, or the previous release of this package when npm has no reference for the pinned DuckDB
// (bench/baseline.ts).
//
// A CI runner is noisy, and on the macOS runner the runs of one scenario spread by up to 60%, so the
// gate does not compare two medians against a fixed limit. The bench runs the packages in pairs of
// children seconds apart (bench/main.ts), and the gate fails only when the pairs show, at 99%
// confidence, that ours is beyond the limit: a one-sided Wilcoxon signed-rank test of each pair's
// log ratio against the limit's. A slow spell on the runner slows both halves of a pair, so it moves
// a pair's ratio far less than it moves either run. bench/README.md explains.

export interface GateLimits {
  /** Largest allowed slowdown, in percent. */
  maxSlowerPct: number;
  /** Largest allowed growth of the run peak RSS, in percent. */
  maxMemoryPct: number;
  /** A difference of medians smaller than this many milliseconds never fails. */
  timeFloorMs: number;
  /** Growth smaller than this many MiB never fails: Bun's baseline differs between the packages. */
  memoryFloorMiB: number;
  /** The largest median, over runs, of the 99th percentile event loop gap while ours runs a long query, in milliseconds. */
  p99GapMs: number;
  /** The largest single event loop gap allowed, in milliseconds: a blocked event loop shows one gap as long as the query. */
  blockedGapMs: number;
  /** One-sided significance level of the test. */
  alpha: number;
}

export const DEFAULT_LIMITS: GateLimits = {
  maxSlowerPct: 10,
  maxMemoryPct: 10,
  timeFloorMs: 5,
  memoryFloorMiB: 16,
  p99GapMs: 50,
  blockedGapMs: 1000,
  alpha: 0.01,
};

/** What the gate reads from one implementation's runs of one scenario. */
export interface GateInput {
  /** Wall time of each measured run, in milliseconds; run k of each implementation is pair k. */
  runsMs: number[];
  /** Peak RSS of each measured run, in MiB, in the same order. */
  runPeaksMiB: number[];
  metrics: Record<string, number>;
  error?: string;
}

export interface Verdict {
  scenario: string;
  /** Pairs of runs the test compared. */
  pairs?: number;
  /** The median over pairs of ours over baseline run time, minus 1, in percent; positive is slower. */
  slowerPct?: number;
  /** One-sided p-value that ours is more than the limit slower. */
  slowerP?: number;
  /** The median over pairs of ours over baseline run peak RSS, minus 1, in percent; positive is more memory. */
  memoryPct?: number;
  /** One-sided p-value that ours uses more than the limit more memory. */
  memoryP?: number;
  failures: string[];
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * One-sided Wilcoxon signed-rank test: the exact p-value for "the differences in `d` tend to be above
 * zero". Zero differences are dropped and tied magnitudes get their average rank, as usual; the null
 * distribution is counted over every assignment of signs to those ranks.
 */
export function signedRankGreater(d: number[]): number {
  const nonzero = d.filter((value) => value !== 0);
  const n = nonzero.length;
  if (n === 0) return 1;
  const order = nonzero.map((value, index) => ({ size: Math.abs(value), index })).sort((a, b) => a.size - b.size);
  // Twice the average rank, so ranks of ties stay integers.
  const doubled = new Array<number>(n).fill(0);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && order[j + 1]?.size === order[i]?.size) j++;
    for (let k = i; k <= j; k++) doubled[order[k]?.index ?? 0] = i + j + 2;
    i = j + 1;
  }
  let observed = 0;
  nonzero.forEach((value, index) => {
    if (value > 0) observed += doubled[index] ?? 0;
  });
  // ways[s]: sign assignments whose positive ranks sum to s (doubled).
  const total = doubled.reduce((sum, rank) => sum + rank, 0);
  let ways = new Array<number>(total + 1).fill(0);
  ways[0] = 1;
  for (const rank of doubled) {
    const next = [...ways];
    for (let sum = rank; sum <= total; sum++) next[sum] = (next[sum] ?? 0) + (ways[sum - rank] ?? 0);
    ways = next;
  }
  let atLeast = 0;
  for (let sum = observed; sum <= total; sum++) atLeast += ways[sum] ?? 0;
  return atLeast / 2 ** n;
}

/** The p-value that ours is more than `limitPct` above baseline, over pairs of runs. */
function beyondLimit(ours: number[], baseline: number[], limitPct: number): number {
  const limit = Math.log(1 + limitPct / 100);
  return signedRankGreater(ours.map((value, k) => Math.log(value / (baseline[k] ?? Number.NaN)) - limit));
}

/** The median over pairs of ours over baseline, minus 1, in percent. */
function pairedPct(ours: number[], baseline: number[]): number {
  return (median(ours.map((value, k) => value / (baseline[k] ?? Number.NaN))) - 1) * 100;
}

export function judge(scenario: string, baseline: GateInput, ours: GateInput, limits: GateLimits): Verdict {
  const verdict: Verdict = { scenario, failures: [] };
  if (baseline.error) verdict.failures.push(`baseline failed: ${baseline.error}`);
  if (ours.error) verdict.failures.push(`ours failed: ${ours.error}`);
  if (baseline.runsMs.length === 0 || ours.runsMs.length === 0) {
    if (verdict.failures.length === 0) verdict.failures.push("no measured runs");
    return verdict;
  }

  if (baseline.runsMs.length !== ours.runsMs.length || baseline.runPeaksMiB.length !== ours.runPeaksMiB.length) {
    verdict.failures.push(
      `unpaired runs: ${ours.runsMs.length} of ours and ${baseline.runsMs.length} of baseline; run k of each must be pair k`,
    );
    return verdict;
  }

  verdict.pairs = ours.runsMs.length;
  const oursMs = median(ours.runsMs);
  const baselineMs = median(baseline.runsMs);
  verdict.slowerPct = pairedPct(ours.runsMs, baseline.runsMs);
  verdict.slowerP = beyondLimit(ours.runsMs, baseline.runsMs, limits.maxSlowerPct);
  if (verdict.slowerP < limits.alpha && oursMs - baselineMs > limits.timeFloorMs) {
    verdict.failures.push(
      `${verdict.slowerPct.toFixed(1)}% slower (${oursMs.toFixed(1)} vs ${baselineMs.toFixed(1)} ms), more than ${limits.maxSlowerPct}% at p = ${verdict.slowerP.toPrecision(2)}`,
    );
  }

  if (baseline.runPeaksMiB.length > 0 && ours.runPeaksMiB.length > 0) {
    const oursMiB = median(ours.runPeaksMiB);
    const baselineMiB = median(baseline.runPeaksMiB);
    verdict.memoryPct = pairedPct(ours.runPeaksMiB, baseline.runPeaksMiB);
    verdict.memoryP = beyondLimit(ours.runPeaksMiB, baseline.runPeaksMiB, limits.maxMemoryPct);
    if (verdict.memoryP < limits.alpha && oursMiB - baselineMiB > limits.memoryFloorMiB) {
      verdict.failures.push(
        `${verdict.memoryPct.toFixed(1)}% more peak RSS per run (${oursMiB.toFixed(0)} vs ${baselineMiB.toFixed(0)} MiB), more than ${limits.maxMemoryPct}% at p = ${verdict.memoryP.toPrecision(2)}`,
      );
    }
  }

  // A busy runner preempts the JS thread now and then: the macOS runner showed single gaps of 85 to
  // 95 ms for both packages. So the 99th percentile carries the timing claim, and the largest gap
  // only has to stay far below the query's length.
  const p99 = ours.metrics.p99GapMs;
  if (p99 !== undefined && p99 >= limits.p99GapMs) {
    verdict.failures.push(`event loop p99 gap ${p99.toFixed(1)} ms, limit ${limits.p99GapMs} ms`);
  }
  const gap = ours.metrics.maxGapMs;
  if (gap !== undefined && gap >= limits.blockedGapMs) {
    verdict.failures.push(`event loop blocked for ${gap.toFixed(1)} ms, limit ${limits.blockedGapMs} ms`);
  }
  return verdict;
}

function signed(value: number | undefined): string {
  if (value === undefined) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function probability(value: number | undefined): string {
  return value === undefined ? "-" : value.toPrecision(2);
}

export function gateTable(verdicts: Verdict[], limits: GateLimits, baseline: string): string {
  const lines = [
    `### Gate: fails when ours is more than ${limits.maxSlowerPct}% slower or ${limits.maxMemoryPct}% heavier than the baseline, ${baseline}, at p < ${limits.alpha}`,
    "",
    "| Scenario | Pairs | Time vs baseline, median pair | p (slower than limit) | Run peak RSS vs baseline, median pair | p (heavier than limit) | Result |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...verdicts.map(
      (v) =>
        `| ${v.scenario} | ${v.pairs ?? "-"} | ${signed(v.slowerPct)} | ${probability(v.slowerP)} | ${signed(v.memoryPct)} | ${probability(v.memoryP)} | ${
          v.failures.length === 0 ? "pass" : `FAIL: ${v.failures.join("; ").replaceAll("|", "\\|")}`
        } |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
