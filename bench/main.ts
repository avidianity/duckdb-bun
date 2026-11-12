// `bun run bench`: generates the input files, runs every scenario against the official
// `@duckdb/node-api` and against ours, each in its own child process, prints one
// Markdown table per scenario and writes the results to `bench/results/`.
//
//   bun run bench [--scenario read-all,prepared] [--impl ours] [--runs 3] [--rows 1000000] [--lag-rows 600000000]
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { writeDataFiles } from "./data.ts";
import { type ChildResult, IMPLEMENTATIONS, type Implementation } from "./runner.ts";
import { type MetricSpec, SCENARIO_NAMES, SCENARIOS, type Scenario } from "./scenarios.ts";

const RUNNER = join(import.meta.dir, "runner.ts");
const RESULTS_DIR = join(import.meta.dir, "results");
const CHILD_TIMEOUT_MS = 15 * 60 * 1000;
const MIB = 1024 * 1024;

interface Summary {
  impl: Implementation;
  duckdbVersion?: string;
  runs: number;
  medianMs?: number;
  minMs?: number;
  maxMs?: number;
  metrics: Record<string, number>;
  peakRssMiB: number;
  maxRssMiB: number;
  error?: string;
  raw: ChildResult;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function aggregate(spec: MetricSpec, values: number[]): number {
  return spec.aggregate === "max" ? Math.max(...values) : median(values);
}

function lastLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

async function runChild(
  impl: Implementation,
  scenario: Scenario,
  dirs: { data: string; root: string },
  options: { runs?: string; rows: string; lagRows: string },
): Promise<ChildResult> {
  const work = join(dirs.root, `work-${impl}-${scenario.name}`);
  const out = join(dirs.root, `result-${impl}-${scenario.name}.json`);
  await mkdir(work, { recursive: true });
  const args = [
    ...["--impl", impl, "--scenario", scenario.name, "--data", dirs.data, "--work", work, "--out", out],
    ...["--rows", options.rows, "--lag-rows", options.lagRows],
    ...(options.runs ? ["--runs", options.runs] : []),
  ];
  const child = Bun.spawn([process.execPath, RUNNER, ...args], {
    stdout: "inherit",
    stderr: "pipe",
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  await rm(work, { recursive: true, force: true });
  try {
    return JSON.parse(await readFile(out, "utf8")) as ChildResult;
  } catch (error) {
    process.stderr.write(stderr);
    const cause = child.signalCode ? `signal ${child.signalCode}` : `code ${code}`;
    const detail = lastLine(stderr) || (error instanceof Error ? error.message : String(error));
    return {
      impl,
      scenario: scenario.name,
      runsMs: [],
      metrics: {},
      peakRssBytes: 0,
      maxRssBytes: 0,
      error: `child exited with ${cause}: ${detail}`,
    };
  }
}

/** One result from the children that ran the same implementation and scenario. */
function merge(raws: ChildResult[]): ChildResult {
  const [first, ...rest] = raws;
  if (!first) throw new Error("merge needs at least one child result");
  const merged: ChildResult = { ...first, runsMs: [...first.runsMs], metrics: structuredClone(first.metrics) };
  for (const raw of rest) {
    merged.runsMs.push(...raw.runsMs);
    for (const [key, values] of Object.entries(raw.metrics)) {
      merged.metrics[key] = [...(merged.metrics[key] ?? []), ...values];
    }
    merged.peakRssBytes = Math.max(merged.peakRssBytes, raw.peakRssBytes);
    merged.maxRssBytes = Math.max(merged.maxRssBytes, raw.maxRssBytes);
    merged.error ??= raw.error;
  }
  return merged;
}

function summarize(scenario: Scenario, raw: ChildResult): Summary {
  const summary: Summary = {
    impl: raw.impl,
    duckdbVersion: raw.duckdbVersion,
    runs: raw.runsMs.length,
    metrics: {},
    peakRssMiB: raw.peakRssBytes / MIB,
    maxRssMiB: raw.maxRssBytes / MIB,
    error: raw.error,
    raw,
  };
  if (raw.runsMs.length > 0) {
    summary.medianMs = median(raw.runsMs);
    summary.minMs = Math.min(...raw.runsMs);
    summary.maxMs = Math.max(...raw.runsMs);
    for (const spec of scenario.metrics) {
      const values = raw.metrics[spec.key] ?? [];
      if (values.length > 0) summary.metrics[spec.key] = aggregate(spec, values);
    }
  }
  return summary;
}

function cell(value: number | undefined, digits = 1): string {
  return value === undefined || Number.isNaN(value) ? "-" : value.toFixed(digits);
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll(/\s+/g, " ").trim();
}

function table(scenario: Scenario, rows: Summary[]): string {
  const header = [
    "Implementation",
    "Runs",
    "Median (ms)",
    "Min (ms)",
    "Max (ms)",
    ...scenario.metrics.map((m) => m.label),
    "Peak RSS (MiB)",
    "Max RSS (MiB)",
    "Error",
  ];
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of rows) {
    const values = [
      row.impl,
      String(row.runs),
      cell(row.medianMs),
      cell(row.minMs),
      cell(row.maxMs),
      ...scenario.metrics.map((m) => cell(row.metrics[m.key])),
      cell(row.peakRssMiB, 0),
      cell(row.maxRssMiB, 0),
      row.error ? escapeCell(row.error) : "",
    ];
    lines.push(`| ${values.join(" | ")} |`);
  }
  return `### ${scenario.title}\n\n${lines.join("\n")}\n`;
}

function list(value: string | undefined, allowed: readonly string[], flag: string): string[] {
  if (!value) return [...allowed];
  const picked = value.split(",").map((v) => v.trim());
  const unknown = picked.filter((v) => !allowed.includes(v));
  if (unknown.length > 0) throw new Error(`${flag}: unknown ${unknown.join(", ")}; expected ${allowed.join(", ")}`);
  return picked;
}

async function packageVersion(path: string): Promise<string> {
  const pkg = (await Bun.file(path).json()) as { version: string };
  return pkg.version;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string" },
      impl: { type: "string" },
      runs: { type: "string" },
      rows: { type: "string", default: "1000000" },
      "lag-rows": { type: "string", default: "600000000" },
    },
    strict: true,
  });
  const scenarioNames = list(values.scenario, SCENARIO_NAMES, "--scenario");
  const impls = list(values.impl, IMPLEMENTATIONS, "--impl") as Implementation[];
  const rows = values.rows;
  const lagRows = values["lag-rows"];
  const root = await mkdtemp(join(tmpdir(), "duckdb-bun-bench-"));
  const results: Record<string, Summary[]> = {};
  try {
    const data = join(root, "data");
    await mkdir(data);
    const needsFiles = scenarioNames.some((n) => n.startsWith("ingest-"));
    if (needsFiles) {
      console.error(`Writing ${rows} rows of JSON and CSV to ${data} ...`);
      await writeDataFiles(data, Number(rows));
    }
    console.log(`## duckdb-bun benchmark (${process.platform}-${process.arch}, Bun ${Bun.version})\n`);
    for (const scenario of SCENARIOS.filter((s) => scenarioNames.includes(s.name))) {
      // ABBA order: each implementation runs once early and once late, so a machine that warms up or
      // throttles during a scenario slows both alike. A fixed order made the second one look slower.
      const raws = new Map<Implementation, ChildResult[]>(impls.map((impl) => [impl, []]));
      for (const impl of [...impls, ...[...impls].reverse()]) {
        console.error(`Running ${scenario.name} on ${impl} ...`);
        const raw = await runChild(impl, scenario, { data, root }, { runs: values.runs, rows, lagRows });
        raws.get(impl)?.push(raw);
      }
      const summaries = impls.map((impl) => summarize(scenario, merge(raws.get(impl) ?? [])));
      results[scenario.name] = summaries;
      console.log(table(scenario, summaries));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const platform = `${process.platform}-${process.arch}`;
  const date = new Date().toISOString().slice(0, 10);
  const file = join(RESULTS_DIR, `${date}-${platform}.json`);
  await mkdir(RESULTS_DIR, { recursive: true });
  const report = {
    date: new Date().toISOString(),
    platform,
    bun: Bun.version,
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    totalMemoryMiB: Math.round(totalmem() / MIB),
    versions: {
      ours: await packageVersion(join(import.meta.dir, "..", "package.json")),
      official: await packageVersion(join(import.meta.dir, "..", "node_modules/@duckdb/node-api/package.json")),
    },
    options: { rows: Number(rows), lagRows: Number(lagRows), runs: values.runs ? Number(values.runs) : "default" },
    scenarios: results,
  };
  await Bun.write(file, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`Wrote ${file}`);
}

await main();
