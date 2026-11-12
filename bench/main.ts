// `bun run bench`: generates the input files, runs every scenario against the baseline (the `@duckdb/node-api`
// reference, or the previous release of this package: bench/baseline.ts) and against ours, each in its own
// child process, prints one
// Markdown table per scenario and writes the results to `bench/results/`, as JSON and Markdown.
//
//   bun run bench [--scenario read-all,prepared] [--impl ours] [--rounds 3] [--rows 1000000] [--lag-rows 600000000]
//                 [--gate] [--max-slower 10] [--max-memory 10]
//
// --gate exits 1 when ours is slower or uses more memory than the limits allow on any scenario (bench/gate.ts).
// With no baseline, before the first release on a DuckDB that npm has no @duckdb/node-api for, it runs ours alone
// and the gate has nothing to judge.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Baseline, baselineLabel, resolveBaseline } from "./baseline.ts";
import { writeDataFiles } from "./data.ts";
import { DEFAULT_LIMITS, type GateInput, type GateLimits, gateTable, judge, median, type Verdict } from "./gate.ts";
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
  /** Median over the measured runs of each run's peak RSS; the gate compares this. */
  runPeakRssMiB?: number;
  error?: string;
  raw: ChildResult;
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
  options: { rows: string; lagRows: string; baselineEntry: string | undefined },
  index: number,
): Promise<ChildResult> {
  const work = join(dirs.root, `work-${impl}-${scenario.name}-${index}`);
  const out = join(dirs.root, `result-${impl}-${scenario.name}-${index}.json`);
  await mkdir(work, { recursive: true });
  const args = [
    ...["--impl", impl, "--scenario", scenario.name, "--data", dirs.data, "--work", work, "--out", out],
    ...["--rows", options.rows, "--lag-rows", options.lagRows, "--runs", "1"],
    ...(impl === "baseline" && options.baselineEntry ? ["--baseline-entry", options.baselineEntry] : []),
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
      runPeakRssBytes: [],
      maxRssBytes: 0,
      error: `child exited with ${cause}: ${detail}`,
    };
  }
}

/** One result from the children that ran the same implementation and scenario. */
function merge(raws: ChildResult[]): ChildResult {
  const [first, ...rest] = raws;
  if (!first) throw new Error("merge needs at least one child result");
  const merged: ChildResult = {
    ...first,
    runsMs: [...first.runsMs],
    runPeakRssBytes: [...first.runPeakRssBytes],
    metrics: structuredClone(first.metrics),
  };
  for (const raw of rest) {
    merged.runsMs.push(...raw.runsMs);
    merged.runPeakRssBytes.push(...raw.runPeakRssBytes);
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
    if (raw.runPeakRssBytes.length > 0) summary.runPeakRssMiB = median(raw.runPeakRssBytes) / MIB;
    for (const spec of scenario.metrics) {
      const values = raw.metrics[spec.key] ?? [];
      if (values.length > 0) summary.metrics[spec.key] = aggregate(spec, values);
    }
  }
  return summary;
}

function gateInput(summary: Summary): GateInput {
  return {
    runsMs: summary.raw.runsMs,
    runPeaksMiB: summary.raw.runPeakRssBytes.map((bytes) => bytes / MIB),
    metrics: summary.metrics,
    error: summary.error,
  };
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
    "Run peak RSS (MiB)",
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
      cell(row.runPeakRssMiB, 0),
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
      rounds: { type: "string" },
      rows: { type: "string", default: "1000000" },
      "lag-rows": { type: "string", default: "600000000" },
      gate: { type: "boolean", default: false },
      "max-slower": { type: "string", default: String(DEFAULT_LIMITS.maxSlowerPct) },
      "max-memory": { type: "string", default: String(DEFAULT_LIMITS.maxMemoryPct) },
    },
    strict: true,
  });
  const limits: GateLimits = {
    ...DEFAULT_LIMITS,
    maxSlowerPct: Number(values["max-slower"]),
    maxMemoryPct: Number(values["max-memory"]),
  };
  const scenarioNames = list(values.scenario, SCENARIO_NAMES, "--scenario");
  let impls = list(values.impl, IMPLEMENTATIONS, "--impl") as Implementation[];
  const rows = values.rows;
  const lagRows = values["lag-rows"];
  if (values.gate && impls.length !== IMPLEMENTATIONS.length) throw new Error("--gate needs both implementations");
  const root = await mkdtemp(join(tmpdir(), "duckdb-bun-bench-"));
  const oursVersion = await packageVersion(join(import.meta.dir, "..", "package.json"));
  let baseline: Baseline | undefined;
  if (impls.includes("baseline")) {
    baseline = await resolveBaseline(oursVersion, join(root, "baseline"));
    if (baseline) {
      console.error(`Baseline: ${baselineLabel(baseline)}`);
    } else {
      console.error(
        "No baseline: npm has no @duckdb/node-api built on the pinned DuckDB and no earlier release of this package," +
          " so the bench runs ours alone and the gate has nothing to judge.",
      );
      impls = impls.filter((impl) => impl !== "baseline");
    }
  }
  const baselineEntry = baseline?.kind === "release" ? baseline.entry : undefined;
  const results: Record<string, Summary[]> = {};
  const tables: string[] = [];
  const verdicts: Verdict[] = [];
  try {
    const data = join(root, "data");
    await mkdir(data);
    const needsFiles = scenarioNames.some((n) => n.startsWith("ingest-"));
    if (needsFiles) {
      console.error(`Writing ${rows} rows of JSON and CSV to ${data} ...`);
      await writeDataFiles(data, Number(rows));
    }
    const heading = `## duckdb-bun benchmark (${process.platform}-${process.arch}, Bun ${Bun.version})\n`;
    tables.push(heading);
    console.log(heading);
    for (const scenario of SCENARIOS.filter((s) => scenarioNames.includes(s.name))) {
      // Rounds of baseline, ours, ours, baseline, one child with one measured run each. Each adjacent
      // baseline and ours child is a pair that ran seconds apart, so a slow spell on the runner slows
      // both halves of a pair alike, and the k-th run of each implementation belong to pair k
      // (bench/gate.ts). Two children per implementation in plain ABBA order put both ours runs
      // back to back, and one slow spell made ours look 28% slower on the macOS runner.
      const rounds = Number(values.rounds ?? scenario.rounds);
      if (!Number.isInteger(rounds) || rounds < 1)
        throw new Error(`--rounds must be a positive integer, got ${values.rounds}`);
      const raws = new Map<Implementation, ChildResult[]>(impls.map((impl) => [impl, []]));
      let child = 0;
      for (let round = 1; round <= rounds; round++) {
        for (const impl of [...impls, ...[...impls].reverse()]) {
          console.error(`Running ${scenario.name} on ${impl}, round ${round} of ${rounds} ...`);
          const raw = await runChild(impl, scenario, { data, root }, { rows, lagRows, baselineEntry }, child++);
          raws.get(impl)?.push(raw);
        }
      }
      const summaries = impls.map((impl) => summarize(scenario, merge(raws.get(impl) ?? [])));
      results[scenario.name] = summaries;
      const rendered = table(scenario, summaries);
      tables.push(rendered);
      console.log(rendered);
      const baseline = summaries.find((s) => s.impl === "baseline");
      const ours = summaries.find((s) => s.impl === "ours");
      if (baseline && ours) verdicts.push(judge(scenario.name, gateInput(baseline), gateInput(ours), limits));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const platform = `${process.platform}-${process.arch}`;
  const date = new Date().toISOString().slice(0, 10);
  const file = join(RESULTS_DIR, `${date}-${platform}.json`);
  const gate = baseline && verdicts.length > 0 ? gateTable(verdicts, limits, baselineLabel(baseline)) : "";
  if (gate) console.log(gate);
  await mkdir(RESULTS_DIR, { recursive: true });
  const report = {
    date: new Date().toISOString(),
    platform,
    bun: Bun.version,
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    totalMemoryMiB: Math.round(totalmem() / MIB),
    versions: { ours: oursVersion },
    baseline: baseline ? { kind: baseline.kind, name: baseline.name, version: baseline.version } : null,
    options: {
      rows: Number(rows),
      lagRows: Number(lagRows),
      rounds: values.rounds ? Number(values.rounds) : "default",
    },
    limits,
    scenarios: results,
    gate: verdicts,
  };
  await Bun.write(file, `${JSON.stringify(report, null, 2)}\n`);
  await Bun.write(file.replace(/\.json$/, ".md"), [...tables, gate].join("\n"));
  console.error(`Wrote ${file} and its .md table`);
  const failed = verdicts.filter((v) => v.failures.length > 0);
  if (values.gate && failed.length > 0) {
    console.error(`Bench gate failed on ${failed.map((v) => v.scenario).join(", ")}.`);
    process.exit(1);
  }
}

await main();
