// The release gate over a bench run: ours may be at most `maxSlowerPct` slower and use at most
// `maxMemoryPct` more peak RSS than the official package, on every scenario. bench/README.md explains
// the limits and the noise they sit above.

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
  peakRssMiB: number;
  metrics: Record<string, number>;
  /** Spread between the medians of the implementation's two children, in percent. */
  noisePct?: number;
  error?: string;
}

export interface Verdict {
  scenario: string;
  /** Ours over official, minus 1, in percent; positive is slower. */
  slowerPct?: number;
  /** Ours over official peak RSS, minus 1, in percent; positive is more memory. */
  memoryPct?: number;
  /** The larger of the two implementations' child-to-child spreads, in percent. */
  noisePct?: number;
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

  verdict.slowerPct = pct(ours.medianMs, official.medianMs);
  if (verdict.slowerPct > limits.maxSlowerPct && ours.medianMs - official.medianMs > limits.timeFloorMs) {
    verdict.failures.push(
      `${verdict.slowerPct.toFixed(1)}% slower (${ours.medianMs.toFixed(1)} vs ${official.medianMs.toFixed(1)} ms), limit ${limits.maxSlowerPct}%`,
    );
  }

  verdict.memoryPct = pct(ours.peakRssMiB, official.peakRssMiB);
  if (verdict.memoryPct > limits.maxMemoryPct && ours.peakRssMiB - official.peakRssMiB > limits.memoryFloorMiB) {
    verdict.failures.push(
      `${verdict.memoryPct.toFixed(1)}% more peak RSS (${ours.peakRssMiB.toFixed(0)} vs ${official.peakRssMiB.toFixed(0)} MiB), limit ${limits.maxMemoryPct}%`,
    );
  }

  const gap = ours.metrics.maxGapMs;
  if (gap !== undefined && gap >= limits.maxGapMs) {
    verdict.failures.push(`event loop gap ${gap.toFixed(1)} ms, limit ${limits.maxGapMs} ms`);
  }
  return verdict;
}

/** Spread between the medians of one implementation's children, in percent of their mean. */
export function noise(childMedians: number[]): number | undefined {
  if (childMedians.length < 2) return undefined;
  const mean = childMedians.reduce((sum, value) => sum + value, 0) / childMedians.length;
  return ((Math.max(...childMedians) - Math.min(...childMedians)) / mean) * 100;
}

function signed(value: number | undefined): string {
  if (value === undefined) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function gateTable(verdicts: Verdict[], limits: GateLimits): string {
  const lines = [
    `### Gate: at most ${limits.maxSlowerPct}% slower and ${limits.maxMemoryPct}% more memory than official`,
    "",
    "| Scenario | Time vs official | Peak RSS vs official | Noise | Result |",
    "| --- | --- | --- | --- | --- |",
    ...verdicts.map(
      (v) =>
        `| ${v.scenario} | ${signed(v.slowerPct)} | ${signed(v.memoryPct)} | ${v.noisePct === undefined ? "-" : `${v.noisePct.toFixed(1)}%`} | ${
          v.failures.length === 0 ? "pass" : `FAIL: ${v.failures.join("; ").replaceAll("|", "\\|")}`
        } |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
