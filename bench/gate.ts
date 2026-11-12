// The release gate over a bench run: ours may be at most `maxSlowerPct` slower and use at most
// `maxMemoryPct` more peak RSS per run than the official package, on every scenario.
//
// A CI runner is noisy, and on the macOS runner the runs of one scenario spread by up to 60%, so the
// gate does not compare two medians against a fixed limit. It fails only when the runs show, at 99%
// confidence, that ours is beyond the limit: a one-sided Mann-Whitney U test of ours against official
// scaled up by the limit. With low noise a small excess fails; with high noise only a large one does.
// bench/README.md explains.

export interface GateLimits {
  /** Largest allowed slowdown, in percent. */
  maxSlowerPct: number;
  /** Largest allowed growth of the run peak RSS, in percent. */
  maxMemoryPct: number;
  /** A difference of medians smaller than this many milliseconds never fails. */
  timeFloorMs: number;
  /** Growth smaller than this many MiB never fails: Bun's baseline differs between the packages. */
  memoryFloorMiB: number;
  /** The event loop's largest gap allowed while ours runs a long query, in milliseconds. */
  maxGapMs: number;
  /** One-sided significance level of the test. */
  alpha: number;
}

export const DEFAULT_LIMITS: GateLimits = {
  maxSlowerPct: 10,
  maxMemoryPct: 10,
  timeFloorMs: 5,
  memoryFloorMiB: 16,
  maxGapMs: 50,
  alpha: 0.01,
};

/** What the gate reads from one implementation's runs of one scenario. */
export interface GateInput {
  /** Wall time of each measured run, in milliseconds. */
  runsMs: number[];
  /** Peak RSS of each measured run, in MiB. */
  runPeaksMiB: number[];
  metrics: Record<string, number>;
  error?: string;
}

export interface Verdict {
  scenario: string;
  /** Ours over official median run time, minus 1, in percent; positive is slower. */
  slowerPct?: number;
  /** One-sided p-value that ours is more than the limit slower. */
  slowerP?: number;
  /** Ours over official median run peak RSS, minus 1, in percent; positive is more memory. */
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

function pct(ours: number, official: number): number {
  return (ours / official - 1) * 100;
}

/** The standard normal upper tail, 1 - Phi(z), by Abramowitz and Stegun 7.1.26 (error below 1.5e-7). */
function upperTail(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = poly * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}

/**
 * One-sided Mann-Whitney U test: the p-value for "values in `a` tend to be larger than values in `b`",
 * by the normal approximation with tie and continuity corrections.
 */
export function mannWhitneyGreater(a: number[], b: number[]): number {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return 1;
  let u = 0;
  for (const x of a) for (const y of b) u += x > y ? 1 : x === y ? 0.5 : 0;
  const counts = new Map<number, number>();
  for (const value of [...a, ...b]) counts.set(value, (counts.get(value) ?? 0) + 1);
  const n = n1 + n2;
  let ties = 0;
  for (const t of counts.values()) ties += t ** 3 - t;
  const variance = ((n1 * n2) / 12) * (n + 1 - ties / (n * (n - 1)));
  if (variance <= 0) return u > (n1 * n2) / 2 ? 0 : 1;
  return upperTail((u - (n1 * n2) / 2 - 0.5) / Math.sqrt(variance));
}

/** The p-value that `ours` is more than `limitPct` above `official`. */
function beyondLimit(ours: number[], official: number[], limitPct: number): number {
  return mannWhitneyGreater(
    ours,
    official.map((value) => value * (1 + limitPct / 100)),
  );
}

export function judge(scenario: string, official: GateInput, ours: GateInput, limits: GateLimits): Verdict {
  const verdict: Verdict = { scenario, failures: [] };
  if (official.error) verdict.failures.push(`official failed: ${official.error}`);
  if (ours.error) verdict.failures.push(`ours failed: ${ours.error}`);
  if (official.runsMs.length === 0 || ours.runsMs.length === 0) {
    if (verdict.failures.length === 0) verdict.failures.push("no measured runs");
    return verdict;
  }

  const oursMs = median(ours.runsMs);
  const officialMs = median(official.runsMs);
  verdict.slowerPct = pct(oursMs, officialMs);
  verdict.slowerP = beyondLimit(ours.runsMs, official.runsMs, limits.maxSlowerPct);
  if (verdict.slowerP < limits.alpha && oursMs - officialMs > limits.timeFloorMs) {
    verdict.failures.push(
      `${verdict.slowerPct.toFixed(1)}% slower (${oursMs.toFixed(1)} vs ${officialMs.toFixed(1)} ms), more than ${limits.maxSlowerPct}% at p = ${verdict.slowerP.toPrecision(2)}`,
    );
  }

  if (official.runPeaksMiB.length > 0 && ours.runPeaksMiB.length > 0) {
    const oursMiB = median(ours.runPeaksMiB);
    const officialMiB = median(official.runPeaksMiB);
    verdict.memoryPct = pct(oursMiB, officialMiB);
    verdict.memoryP = beyondLimit(ours.runPeaksMiB, official.runPeaksMiB, limits.maxMemoryPct);
    if (verdict.memoryP < limits.alpha && oursMiB - officialMiB > limits.memoryFloorMiB) {
      verdict.failures.push(
        `${verdict.memoryPct.toFixed(1)}% more peak RSS per run (${oursMiB.toFixed(0)} vs ${officialMiB.toFixed(0)} MiB), more than ${limits.maxMemoryPct}% at p = ${verdict.memoryP.toPrecision(2)}`,
      );
    }
  }

  const gap = ours.metrics.maxGapMs;
  if (gap !== undefined && gap >= limits.maxGapMs) {
    verdict.failures.push(`event loop gap ${gap.toFixed(1)} ms, limit ${limits.maxGapMs} ms`);
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

export function gateTable(verdicts: Verdict[], limits: GateLimits): string {
  const lines = [
    `### Gate: fails when ours is more than ${limits.maxSlowerPct}% slower or ${limits.maxMemoryPct}% heavier than official at p < ${limits.alpha}`,
    "",
    "| Scenario | Median time vs official | p (slower than limit) | Median run peak RSS vs official | p (heavier than limit) | Result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...verdicts.map(
      (v) =>
        `| ${v.scenario} | ${signed(v.slowerPct)} | ${probability(v.slowerP)} | ${signed(v.memoryPct)} | ${probability(v.memoryP)} | ${
          v.failures.length === 0 ? "pass" : `FAIL: ${v.failures.join("; ").replaceAll("|", "\\|")}`
        } |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
