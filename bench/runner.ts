// Child process: runs one scenario against one implementation and writes a
// `ChildResult` as JSON to `--out`. The parent (`bench/main.ts`) starts one child per
// implementation and scenario, so RSS numbers never mix between them.
//
//   bun bench/runner.ts --impl ours --scenario read-all --data <dir> --work <dir> --out <file> [--runs 1]
import { parseArgs } from "node:util";
import { assertRealOfficialBinding } from "../tests/official-binding.ts";
import { SCENARIOS, type ScenarioContext } from "./scenarios.ts";

export const IMPLEMENTATIONS = ["official", "ours"] as const;
export type Implementation = (typeof IMPLEMENTATIONS)[number];

export interface ChildResult {
  impl: Implementation;
  scenario: string;
  /** `SELECT version()` as the implementation reports it. */
  duckdbVersion?: string;
  /** Wall time of each measured run, in milliseconds. */
  runsMs: number[];
  /** Per-run values of the scenario's extra metrics. */
  metrics: Record<string, number[]>;
  /** Highest RSS the in-process sampler saw, in bytes. */
  peakRssBytes: number;
  /** Highest RSS during each measured run, which starts after a full garbage collection, in bytes. */
  runPeakRssBytes: number[];
  /** The OS high-water mark from getrusage (`process.resourceUsage().maxRSS`), in bytes. */
  maxRssBytes: number;
  error?: string;
}

type Api = typeof import("@duckdb/node-api");

const RSS_SAMPLE_MS = 10;

async function loadApi(impl: Implementation): Promise<Api> {
  if (impl === "official") {
    assertRealOfficialBinding();
    return import("@duckdb/node-api");
  }
  // Ours re-exports the same vendored classes; the cast only bridges the two
  // declaration sites, which TypeScript treats as distinct class types.
  return (await import("../src/neo.ts")) as unknown as Api;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      impl: { type: "string" },
      scenario: { type: "string" },
      data: { type: "string" },
      work: { type: "string" },
      out: { type: "string" },
      runs: { type: "string" },
      rows: { type: "string" },
      "lag-rows": { type: "string" },
    },
    strict: true,
  });
  const impl = values.impl as Implementation;
  if (!IMPLEMENTATIONS.includes(impl)) throw new Error(`--impl must be one of ${IMPLEMENTATIONS.join(", ")}`);
  const scenario = SCENARIOS.find((s) => s.name === values.scenario);
  if (!scenario) throw new Error(`unknown --scenario ${values.scenario}`);
  if (!values.data || !values.work || !values.out) throw new Error("--data, --work and --out are required");

  let peakRssBytes = process.memoryUsage.rss();
  let runPeakRssBytes = 0;
  const sample = () => {
    const rss = process.memoryUsage.rss();
    peakRssBytes = Math.max(peakRssBytes, rss);
    runPeakRssBytes = Math.max(runPeakRssBytes, rss);
  };
  const sampler = setInterval(sample, RSS_SAMPLE_MS);

  const result: ChildResult = {
    impl,
    scenario: scenario.name,
    runsMs: [],
    metrics: Object.fromEntries(scenario.metrics.map((m) => [m.key, []])),
    peakRssBytes: 0,
    runPeakRssBytes: [],
    maxRssBytes: 0,
  };

  try {
    const api = await loadApi(impl);
    // Extensions this bench needs (json, parquet) are built in; never reach the network.
    const instance = await api.DuckDBInstance.create(":memory:", {
      autoinstall_known_extensions: "false",
      autoload_known_extensions: "false",
    });
    const conn = await instance.connect();
    try {
      result.duckdbVersion = String((await conn.runAndReadAll("SELECT version()")).getRows()[0]?.[0]);
      const ctx: ScenarioContext = {
        conn,
        dataDir: values.data,
        workDir: values.work,
        rows: Number(values.rows ?? 1_000_000),
        lagRows: Number(values["lag-rows"] ?? 600_000_000),
      };
      const runs = Number(values.runs ?? 1);
      await scenario.setup?.(ctx);
      if (scenario.warmup) await scenario.run(ctx, -1);
      for (let i = 0; i < runs; i++) {
        Bun.gc(true);
        runPeakRssBytes = 0;
        sample();
        const t0 = performance.now();
        const metrics = await scenario.run(ctx, i);
        result.runsMs.push(performance.now() - t0);
        sample();
        result.runPeakRssBytes.push(runPeakRssBytes);
        for (const spec of scenario.metrics) result.metrics[spec.key]?.push(metrics[spec.key] ?? Number.NaN);
      }
      await scenario.verify?.(ctx);
    } finally {
      conn.closeSync();
      instance.closeSync();
    }
  } catch (error) {
    result.error = errorText(error);
  } finally {
    clearInterval(sampler);
    sample();
  }

  result.peakRssBytes = peakRssBytes;
  // Bun reports maxRSS in kibibytes, as Node does.
  result.maxRssBytes = process.resourceUsage().maxRSS * 1024;
  await Bun.write(values.out, JSON.stringify(result));
}

if (import.meta.main) await main();
