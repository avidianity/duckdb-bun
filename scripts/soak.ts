// Soak run: a service-like load on one long-lived instance for a set time, sampled
// every few seconds, failing on memory growth, leaked handles or a stalled event loop.
//
//   bun run soak                    45 minutes, a report in soak-report/
//   bun run soak --minutes 5 --out /tmp/soak
//   SOAK_SEED=<n> bun run soak      repeats a run's random choices
//
// The load follows what tests/parity/service-surface.test.ts covers: an instance
// hardened with SET statements and locked, a pool of connections that each keep a
// temp view and prepared statements, NDJSON and CSV reads over temp files, a
// Parquet view, `?` and `$n` parameters, streamed reads chunk by chunk, short
// queries, errors, and a connection opened and closed per request now and then.
// Every answer is checked.
//
// Every SAMPLE seconds it records RSS, the JS heap, live native handles, jobs in
// flight, native threads running a job, OS threads and job pool threads (Linux),
// and the event loop timer gaps. After the load it closes everything and checks
// that handles and pool threads go back to where they started.
//
// It writes soak.json (every sample and check) and soak.md (a summary) to the
// output folder, appends the summary to $GITHUB_STEP_SUMMARY when set, and exits
// with 1 when a check fails. CONTRIBUTING.md ("Soak") describes the checks.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type DuckDBConnection, DuckDBInstance, type DuckDBPreparedStatement, diagnostics } from "../src/neo.ts";
import { EventLoopProbe, poolThreads, quantile, Random, seedFrom, threadNames } from "../tests/heavy/workload.ts";

/**
 * The largest RSS growth allowed over the second half of the run, as the slope of a
 * least-squares line through its samples. DuckDB's buffer pool and the allocators
 * grow during the first half and then level off; a leak of one kilobyte per request
 * at the rate this load runs grows RSS by several MiB a minute.
 */
const MAX_RSS_SLOPE_MIB_PER_MINUTE = 1;
/** The same bound as tests/heavy/event-loop-stress.test.ts, which explains it. */
const P99_GAP_MS = 50;
/** `IDLE_TIMEOUT` in native/src/pool.rs. */
const POOL_IDLE_TIMEOUT_MS = 10_000;
/** Requests in flight at once, one per pooled connection. */
const HANDLERS = 8;
/** The longest pause a handler takes between requests. */
const THINK_MS = 20;
const LOG_HOURS = 24;
const LOG_LINES_PER_FILE = 600;
const LEVELS = ["info", "warn", "error"] as const;
const CSV_ROWS = 20_000;
const PARQUET_ROWS = 200_000;
const PARQUET_GROUPS = 50;

const { values: args } = parseArgs({
  options: {
    minutes: { type: "string", default: "45" },
    "sample-seconds": { type: "string", default: "5" },
    out: { type: "string", default: "soak-report" },
  },
});
const minutes = Number(args.minutes);
const sampleSeconds = Number(args["sample-seconds"]);
if (!(minutes > 0) || !(sampleSeconds > 0)) {
  throw new Error(`--minutes and --sample-seconds must be positive, got ${args.minutes} and ${args["sample-seconds"]}`);
}
const out = resolve(args.out);
const seed = seedFrom("SOAK_SEED");

interface Sample {
  /** Seconds since the load started. */
  t: number;
  rssMiB: number;
  heapUsedMiB: number;
  liveHandles: number;
  liveHandlesByKind: Record<string, number>;
  jobsInFlight: number;
  jobsStarted: number;
  nativeThreadsRunning: number;
  /** All OS threads of the process, Linux only. */
  osThreads: number | null;
  /** Job pool threads, busy or idle, Linux only. */
  poolThreads: number | null;
  ticks: number;
  gapP99Ms: number;
  gapMaxMs: number;
  requests: number;
}

interface Check {
  name: string;
  /** null when the platform cannot measure it. */
  pass: boolean | null;
  detail: string;
}

const mib = (bytes: number) => bytes / 2 ** 20;
const sum = (record: Record<string, number>) => Object.values(record).reduce((a, b) => a + b, 0);
const triangle = (n: number) => (BigInt(n) * BigInt(n - 1)) / 2n;

/** The slope of the least-squares line through `points`, in y units per x unit. */
function slope(points: readonly [number, number][]): number {
  const n = points.length;
  if (n < 2) return 0;
  const meanX = points.reduce((a, [x]) => a + x, 0) / n;
  const meanY = points.reduce((a, [, y]) => a + y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    numerator += (x - meanX) * (y - meanY);
    denominator += (x - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Writes the temp files the load reads, and returns their paths. */
function writeData(folder: string) {
  const logs = join(folder, "logs");
  for (let hour = 0; hour < LOG_HOURS; hour++) {
    const dir = join(logs, "2026-01-15", String(hour).padStart(2, "0"));
    mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (let j = 0; j < LOG_LINES_PER_FILE; j++) {
      lines.push(
        JSON.stringify({
          id: `${hour}-${j}`,
          at: new Date(Date.UTC(2026, 0, 15, hour, 0, j % 60)).toISOString(),
          level: LEVELS[j % LEVELS.length],
          message: `request ${j}`,
          context: { route: `/r${j % 7}`, ms: j % 100, tags: ["a", `t${j % 5}`] },
        }),
      );
    }
    writeFileSync(join(dir, "part.ndjson"), `${lines.join("\n")}\n`);
  }
  const csv = join(folder, "data.csv");
  const rows = ["id,grp,amount"];
  for (let id = 0; id < CSV_ROWS; id++) rows.push(`${id},${id % 10},${id % 1000}`);
  writeFileSync(csv, `${rows.join("\n")}\n`);
  return { logs, csv, parquet: join(folder, "dataset.parquet"), spill: join(folder, "spill") };
}

/** The SET sequence a service applies before it hands out connections (tests/parity/service-surface.test.ts). */
function hardening(allowed: string): string[] {
  return [
    "set allow_unsigned_extensions = false",
    "set allow_community_extensions = false",
    "set autoinstall_known_extensions = false",
    "set autoload_known_extensions = false",
    "set allow_persistent_secrets = false",
    "set enable_external_file_cache = false",
    "set enable_http_metadata_cache = false",
    "set enable_object_cache = false",
    "set parquet_metadata_cache = false",
    `set allowed_directories = ['${allowed}/']`,
    "set enable_external_access = false",
    "set lock_configuration = true",
  ];
}

/** A pooled connection and the statements it keeps, as a service caches them. */
interface Pooled {
  connection: DuckDBConnection;
  csvByGroup: DuckDBPreparedStatement;
  groups: DuckDBPreparedStatement;
}

async function main(): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "duckdb-bun-soak-"));
  const random = new Random(seed);
  const failures: string[] = [];
  const requestsByKind: Record<string, number> = {};
  let requests = 0;
  const samples: Sample[] = [];
  const probe = new EventLoopProbe();
  const allGaps: number[] = [];
  const baseline = diagnostics().liveHandles;
  console.log(`soak: ${minutes} min, a sample every ${sampleSeconds} s, seed ${seed} (SOAK_SEED=${seed} repeats it)`);

  try {
    const files = writeData(folder);
    const instance = await DuckDBInstance.create(":memory:", {
      TimeZone: "UTC",
      threads: "2",
      memory_limit: "512MB",
      temp_directory: files.spill,
      max_temp_directory_size: "1GB",
      preserve_insertion_order: "false",
    });
    const setup = await instance.connect();
    await setup.run(
      `copy (select id, id % ${PARQUET_GROUPS} as g, id % 1000 as v, 'row ' || id as s from range(${PARQUET_ROWS}) t(id)) to '${files.parquet}' (format parquet)`,
    );
    for (const sql of hardening(folder)) await setup.run(sql);

    const logRelation = `read_json('${files.logs}/*/*/*.ndjson', format = 'newline_delimited', filename = true,
      columns = {'id': 'VARCHAR', 'at': 'VARCHAR', 'level': 'VARCHAR', 'message': 'VARCHAR', 'context': 'JSON'})`;
    const groupSums = new Map<number, bigint>();
    for (let id = 0; id < PARQUET_ROWS; id++) {
      const g = id % PARQUET_GROUPS;
      groupSums.set(g, (groupSums.get(g) ?? 0n) + BigInt(id % 1000));
    }
    const csvSums = new Map<number, bigint>();
    for (let id = 0; id < CSV_ROWS; id++) csvSums.set(id % 10, (csvSums.get(id % 10) ?? 0n) + BigInt(id % 1000));

    const pool: Pooled[] = [];
    for (let i = 0; i < HANDLERS; i++) {
      const connection = await instance.connect();
      await connection.run(`create temp view dataset as select * from read_parquet('${files.parquet}')`);
      pool.push({
        connection,
        csvByGroup: await connection.prepare(
          `select count(*), sum(amount)::BIGINT from read_csv('${files.csv}') where grp = $1`,
        ),
        groups: await connection.prepare(
          "select g, count(*), sum(v)::BIGINT from dataset where g < $1 group by g order by g",
        ),
      });
    }

    const check = (kind: string, actual: unknown, expected: unknown) => {
      if (!Bun.deepEquals(actual, expected, true)) {
        failures.push(`${kind}: got ${Bun.inspect(actual)}, expected ${Bun.inspect(expected)}`);
      }
    };

    /** One request of a randomly chosen kind on `pooled`. */
    async function request(pooled: Pooled, rand: Random): Promise<void> {
      const { connection } = pooled;
      const kind = rand.pick([
        "logs",
        "logs",
        "csv",
        "csv",
        "parquet",
        "parquet",
        "stream",
        "stream",
        "short",
        "variable",
        "serialize",
        "error",
        "own connection",
      ]);
      requestsByKind[kind] = (requestsByKind[kind] ?? 0) + 1;
      if (kind === "logs") {
        const hour = rand.int(0, LOG_HOURS - 1);
        const level = rand.pick(LEVELS);
        const from = `${files.logs}/2026-01-15/${String(hour).padStart(2, "0")}/`;
        const reader = await connection.runAndReadAll(
          `select count(*), count(distinct json_extract_string(context, '/route')) from ${logRelation}
           where level = ? and filename >= ?`,
          [level, from],
        );
        check(kind, reader.getRows(), [[BigInt(((LOG_HOURS - hour) * LOG_LINES_PER_FILE) / LEVELS.length), BigInt(7)]]);
      } else if (kind === "csv") {
        const group = rand.int(0, 9);
        pooled.csvByGroup.bindInteger(1, group);
        check(kind, (await pooled.csvByGroup.runAndReadAll()).getRows(), [[BigInt(CSV_ROWS / 10), csvSums.get(group)]]);
      } else if (kind === "parquet") {
        const below = rand.int(1, PARQUET_GROUPS);
        pooled.groups.bindInteger(1, below);
        check(
          kind,
          (await pooled.groups.runAndReadAll()).getRows(),
          Array.from({ length: below }, (_, g) => [BigInt(g), BigInt(PARQUET_ROWS / PARQUET_GROUPS), groupSums.get(g)]),
        );
      } else if (kind === "stream") {
        const n = rand.int(0, 100_000);
        const result = await connection.stream("select id, g, v, s from dataset where id < $1", [n]);
        let rows = 0;
        let ids = 0n;
        const columns = result.columnTypes().length;
        if (columns !== 4) failures.push(`${kind}: ${columns} columns before the first chunk, expected 4`);
        for (;;) {
          const chunk = await result.fetchChunk();
          if (!chunk || chunk.rowCount === 0) break;
          rows += chunk.rowCount;
          for (const [id] of chunk.getRows()) ids += id as bigint;
        }
        check(kind, [rows, ids], [n, triangle(n)]);
      } else if (kind === "short") {
        check(kind, (await connection.runAndReadAll("select 42 as answer")).getRows(), [[42]]);
      } else if (kind === "variable") {
        const path = `/data/${rand.int(0, 1000)}.parquet`;
        await connection.run("set variable some_path = ?", [path]);
        check(kind, (await connection.runAndReadAll("select getvariable('some_path')")).getRows(), [[path]]);
      } else if (kind === "serialize") {
        const reader = await connection.runAndReadAll("select json_serialize_sql(cast(? as varchar))", [
          `select g, sum(v) from dataset where g = ${rand.int(0, 49)} group by g`,
        ]);
        const text = String(reader.getRows()[0]?.[0]);
        if (!text.includes('"error":false')) failures.push(`${kind}: ${text.slice(0, 200)}`);
      } else if (kind === "error") {
        try {
          await connection.run("selec nope");
          failures.push(`${kind}: a syntax error resolved`);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("Parser Error: syntax error")) {
            failures.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } else {
        const own = await instance.connect();
        try {
          check(kind, (await own.runAndReadAll("select count(*) from read_parquet(?)", [files.parquet])).getRows(), [
            [BigInt(PARQUET_ROWS)],
          ]);
        } finally {
          own.closeSync();
        }
      }
      requests++;
    }

    const started = performance.now();
    const end = started + minutes * 60_000;
    probe.start();
    const sampler = setInterval(() => {
      const d = diagnostics();
      const memory = process.memoryUsage();
      const gaps = probe.take();
      allGaps.push(...gaps);
      samples.push({
        t: Math.round((performance.now() - started) / 100) / 10,
        rssMiB: mib(memory.rss),
        heapUsedMiB: mib(memory.heapUsed),
        liveHandles: sum(d.liveHandles),
        liveHandlesByKind: d.liveHandles,
        jobsInFlight: d.jobs.inFlight,
        jobsStarted: d.jobs.started,
        nativeThreadsRunning: d.nativeThreads.running,
        osThreads: threadNames()?.length ?? null,
        poolThreads: poolThreads(),
        ticks: gaps.length,
        gapP99Ms: quantile(gaps, 0.99),
        gapMaxMs: gaps.length ? Math.max(...gaps) : 0,
        requests,
      });
      const last = samples.at(-1);
      if (last && samples.length % Math.max(1, Math.round(60 / sampleSeconds)) === 0) {
        console.log(
          `${(last.t / 60).toFixed(1)} min: RSS ${last.rssMiB.toFixed(1)} MiB, handles ${last.liveHandles}, requests ${requests}, p99 gap ${last.gapP99Ms.toFixed(1)} ms, failures ${failures.length}`,
        );
      }
    }, sampleSeconds * 1000);

    await Promise.all(
      pool.map(async (pooled, index) => {
        const rand = random.fork(index);
        while (performance.now() < end) {
          try {
            await request(pooled, rand);
          } catch (error) {
            failures.push(`request: ${error instanceof Error ? error.message : String(error)}`);
          }
          await Bun.sleep(rand.int(0, THINK_MS));
        }
      }),
    );
    clearInterval(sampler);
    probe.stop();
    allGaps.push(...probe.take());
    const inFlightAfterLoad = diagnostics().jobs.inFlight;

    for (const pooled of pool) {
      pooled.csvByGroup.destroySync();
      pooled.groups.destroySync();
      pooled.connection.closeSync();
    }
    setup.closeSync();
    instance.closeSync();

    let poolAtEnd = poolThreads();
    const poolDeadline = performance.now() + POOL_IDLE_TIMEOUT_MS + 5000;
    while (poolAtEnd !== null && poolAtEnd > 0 && performance.now() < poolDeadline) {
      await Bun.sleep(250);
      poolAtEnd = poolThreads();
    }
    for (let i = 0; i < 50 && !Bun.deepEquals(diagnostics().liveHandles, baseline); i++) {
      Bun.gc(true);
      await Bun.sleep(20);
    }
    const handlesAtEnd = diagnostics().liveHandles;

    const secondHalf = samples.filter((s) => s.t >= (minutes * 60) / 2);
    const rssSlope = slope(secondHalf.map((s) => [s.t / 60, s.rssMiB]));
    const gapP99 = quantile(allGaps, 0.99);
    const checks: Check[] = [
      {
        name: "every request answered correctly",
        pass: failures.length === 0,
        detail: `${requests} requests, ${failures.length} failed`,
      },
      {
        name: `RSS slope over the second half at most ${MAX_RSS_SLOPE_MIB_PER_MINUTE} MiB/min`,
        pass: secondHalf.length >= 2 && rssSlope <= MAX_RSS_SLOPE_MIB_PER_MINUTE,
        detail: `${rssSlope.toFixed(3)} MiB/min over ${secondHalf.length} samples`,
      },
      {
        name: `p99 event loop gap under ${P99_GAP_MS} ms`,
        pass: gapP99 < P99_GAP_MS,
        detail: `${gapP99.toFixed(1)} ms over ${allGaps.length} ticks, max ${Math.max(0, ...allGaps).toFixed(1)} ms`,
      },
      {
        name: "no job in flight after the load",
        pass: inFlightAfterLoad === 0,
        detail: `${inFlightAfterLoad} in flight`,
      },
      {
        name: "live handles back to the baseline after closing and collecting",
        pass: Bun.deepEquals(handlesAtEnd, baseline),
        detail: `baseline ${JSON.stringify(baseline)}, at the end ${JSON.stringify(handlesAtEnd)}`,
      },
      {
        name: "idle job pool threads exit",
        pass: poolAtEnd === null ? null : poolAtEnd === 0,
        detail: poolAtEnd === null ? "not measured: procfs lists thread names on Linux only" : `${poolAtEnd} left`,
      },
    ];
    report({ checks, samples, failures, requestsByKind, requests, rssSlope });
    if (checks.some((c) => c.pass === false)) process.exitCode = 1;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }

  function report(result: {
    checks: Check[];
    samples: Sample[];
    failures: string[];
    requestsByKind: Record<string, number>;
    requests: number;
    rssSlope: number;
  }): void {
    const d = diagnostics();
    const environment = {
      versions: d.versions,
      platform: `${process.platform}-${process.arch}`,
      cores: availableParallelism(),
      minutes,
      sampleSeconds,
      seed,
      handlers: HANDLERS,
      thresholds: { maxRssSlopeMiBPerMinute: MAX_RSS_SLOPE_MIB_PER_MINUTE, p99GapMs: P99_GAP_MS },
    };
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "soak.json"),
      `${JSON.stringify({ environment, ...result, failures: result.failures.slice(0, 100) }, null, 2)}\n`,
    );

    const mark = (pass: boolean | null) => (pass === null ? "not measured" : pass ? "pass" : "FAIL");
    const rows = result.samples.filter((_, i, all) => i % Math.max(1, Math.ceil(all.length / 30)) === 0);
    const value = (n: number | null, digits = 0) => (n === null ? "-" : n.toFixed(digits));
    const markdown = [
      `# Soak report`,
      "",
      `${minutes} min on ${environment.platform} with ${environment.cores} cores, seed ${seed}; package ${d.versions.package}, DuckDB ${d.versions.duckdb}, Bun ${d.versions.bun}.`,
      `${result.requests} requests from ${HANDLERS} handlers: ${Object.entries(result.requestsByKind)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ")}.`,
      "",
      "| Check | Result | Measured |",
      "| --- | --- | --- |",
      ...result.checks.map((c) => `| ${c.name} | ${mark(c.pass)} | ${c.detail} |`),
      "",
      "| Minute | RSS MiB | Heap MiB | Handles | Jobs in flight | Running jobs | OS threads | Pool threads | p99 gap ms | Requests |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...rows.map(
        (s) =>
          `| ${(s.t / 60).toFixed(1)} | ${s.rssMiB.toFixed(1)} | ${s.heapUsedMiB.toFixed(1)} | ${s.liveHandles} | ${s.jobsInFlight} | ${s.nativeThreadsRunning} | ${value(s.osThreads)} | ${value(s.poolThreads)} | ${s.gapP99Ms.toFixed(1)} | ${s.requests} |`,
      ),
      "",
      ...(result.failures.length
        ? ["First failures:", "", ...result.failures.slice(0, 10).map((f) => `- \`${f.replaceAll("`", "'")}\``), ""]
        : []),
    ].join("\n");
    writeFileSync(join(out, "soak.md"), markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    console.log(markdown);
  }
}

await main();
