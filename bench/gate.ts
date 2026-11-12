// The release gate over a bench run: ours may be at most `maxSlowerPct` slower and use at most
// `maxMemoryPct` more peak RSS per run than the official package, on every scenario. When the runner's
// own noise in a scenario is larger than a limit, the noise is the limit for that scenario: a difference
// inside the spread between two children running the same code is no evidence. A slowdown counts only
// when both the median and the fastest run show it, so a scenario whose runs fall into two speed modes
// cannot fail on which mode each implementation happened to hit. bench/README.md explains.

export interface GateLimits {
  /** Largest allowed slowdown of the median run, in percent. */
  maxSlowerPct: number;
  /** Largest allowed growth of peak RSS, in percent. */
  maxMemoryPct: number;
  /** A slowdown smaller than this many milliseconds never fails, whatever its percentage. */
  timeFloorMs: number;
  /** Growth smaller than this many MiB never fails, whatever its percentage: Bun's baseline differs. */
  memoryFloorMiB: number;
  /** The event loop's largest gap allowed while ours runs a long query, in milliseconds. */
  maxGapMs: number;
}

export const DEFAULT_LIMITS: GateLimits = {
  maxSlowerPct: 10,
  maxMemoryPct: 10,
  timeFloorMs: 5,
  memoryFloorMiB: 16,
  maxGapMs: 50,
};

/** What the gate reads from one implementation's summary of one scenario. */
export interface GateInput {
  medianMs?: number;
  minMs?: number;
  /** Median over the runs of each run's peak RSS. */
  runPeakRssMiB?: number;
  metrics: Record<string, number>;
  /** Spread between the medians of the implementation's two children, in percent. */
  noisePct?: number;
  /** The same spread for the median run peak RSS, in percent. */
  memoryNoisePct?: number;
  error?: string;
}

export interface Verdict {
  scenario: string;
  /** Ours over official median, minus 1, in percent; positive is slower. */
  slowerPct?: number;
  /** The same for the fastest run. */
  minSlowerPct?: number;
  /** Ours over official run peak RSS, minus 1, in percent; positive is more memory. */
  memoryPct?: number;
  /** The larger of the two implementations' child-to-child spreads of the median, in percent. */
  noisePct?: number;
  /** The same for peak RSS. */
  memoryNoisePct?: number;
  /** The limits applied: the configured ones, raised to the noise where it is larger. */
  timeLimitPct?: number;
  memoryLimitPct?: number;
  failures: string[];
}

function pct(ours: number, official: number): number {
  return (ours / official - 1) * 100;
}

export function judge(scenario: string, official: GateInput, ours: GateInput, limits: GateLimits): Verdict {
  const verdict: Verdict = { scenario, failures: [] };
  if (official.error) verdict.failures.push(`official failed: ${official.error}`);
  if (ours.error) verdict.failures.push(`ours failed: ${ours.error}`);
  if (official.medianMs === undefined || ours.medianMs === undefined) {
    if (verdict.failures.length === 0) verdict.failures.push("no measured runs");
    return verdict;
  }
  verdict.noisePct = Math.max(official.noisePct ?? 0, ours.noisePct ?? 0);
  verdict.memoryNoisePct = Math.max(official.memoryNoisePct ?? 0, ours.memoryNoisePct ?? 0);
  verdict.timeLimitPct = Math.max(limits.maxSlowerPct, verdict.noisePct);
  verdict.memoryLimitPct = Math.max(limits.maxMemoryPct, verdict.memoryNoisePct);

  verdict.slowerPct = pct(ours.medianMs, official.medianMs);
  verdict.minSlowerPct = pct(ours.minMs ?? ours.medianMs, official.minMs ?? official.medianMs);
  if (
    verdict.slowerPct > verdict.timeLimitPct &&
    verdict.minSlowerPct > verdict.timeLimitPct &&
    ours.medianMs - official.medianMs > limits.timeFloorMs
  ) {
    verdict.failures.push(
      `${verdict.slowerPct.toFixed(1)}% slower (${ours.medianMs.toFixed(1)} vs ${official.medianMs.toFixed(1)} ms), fastest run ${verdict.minSlowerPct.toFixed(1)}% slower, limit ${verdict.timeLimitPct.toFixed(1)}%`,
    );
  }

  if (ours.runPeakRssMiB !== undefined && official.runPeakRssMiB !== undefined) {
    verdict.memoryPct = pct(ours.runPeakRssMiB, official.runPeakRssMiB);
    if (
      verdict.memoryPct > verdict.memoryLimitPct &&
      ours.runPeakRssMiB - official.runPeakRssMiB > limits.memoryFloorMiB
    ) {
      verdict.failures.push(
        `${verdict.memoryPct.toFixed(1)}% more peak RSS per run (${ours.runPeakRssMiB.toFixed(0)} vs ${official.runPeakRssMiB.toFixed(0)} MiB), limit ${verdict.memoryLimitPct.toFixed(1)}%`,
      );
    }
  }

  const gap = ours.metrics.maxGapMs;
  if (gap !== undefined && gap >= limits.maxGapMs) {
    verdict.failures.push(`event loop gap ${gap.toFixed(1)} ms, limit ${limits.maxGapMs} ms`);
  }
  return verdict;
}

/** Spread between one number per child of one implementation, in percent of their mean. */
export function noise(perChild: number[]): number | undefined {
  if (perChild.length < 2) return undefined;
  const mean = perChild.reduce((sum, value) => sum + value, 0) / perChild.length;
  return ((Math.max(...perChild) - Math.min(...perChild)) / mean) * 100;
}

function percent(value: number | undefined): string {
  return value === undefined ? "-" : `${value.toFixed(1)}%`;
}

function signed(value: number | undefined): string {
  if (value === undefined) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function gateTable(verdicts: Verdict[], limits: GateLimits): string {
  const lines = [
    `### Gate: at most ${limits.maxSlowerPct}% slower and ${limits.maxMemoryPct}% more memory than official, or the noise where larger`,
    "",
    "| Scenario | Median vs official | Fastest vs official | Time noise | Run peak RSS vs official | RSS noise | Result |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...verdicts.map(
      (v) =>
        `| ${v.scenario} | ${signed(v.slowerPct)} | ${signed(v.minSlowerPct)} | ${percent(v.noisePct)} | ${signed(v.memoryPct)} | ${percent(v.memoryNoisePct)} | ${
          v.failures.length === 0 ? "pass" : `FAIL: ${v.failures.join("; ").replaceAll("|", "\\|")}`
        } |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
