// The benchmark scenarios. Each one uses only the public `@duckdb/node-api` surface,
// so the same code runs against the official package and against ours.
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";

export interface ScenarioContext {
  conn: DuckDBConnection;
  /** Input files written by the parent, shared read-only across children. */
  dataDir: string;
  /** Scratch directory owned by this child; the parent removes it. */
  workDir: string;
  /** Rows in the generated input files and tables. */
  rows: number;
  /** Rows the event-loop lag query hashes. */
  lagRows: number;
}

export interface MetricSpec {
  key: string;
  label: string;
  /** How per-run values combine into the reported number. */
  aggregate: "median" | "max";
}

export interface Scenario {
  name: string;
  title: string;
  /**
   * Rounds of official, ours, ours, official, one child with one measured run each, so each
   * implementation gets twice this many runs and the gate twice this many pairs (bench/gate.ts).
   */
  rounds: number;
  /** Run once unmeasured in each child before its measured run. */
  warmup: boolean;
  metrics: MetricSpec[];
  setup?(ctx: ScenarioContext): Promise<void>;
  /** Checks the result once after the measured runs, outside the timing. */
  verify?(ctx: ScenarioContext): Promise<void>;
  /** One measured run. Returns the scenario's extra metrics, keyed by `MetricSpec.key`. */
  run(ctx: ScenarioContext, index: number): Promise<Record<string, number>>;
}

export const PREPARED_ITERATIONS = 10_000;
const LAG_INTERVAL_MS = 10;

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function scalar(conn: DuckDBConnection, sql: string): Promise<unknown> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRows()[0]?.[0];
}

async function expectCount(conn: DuckDBConnection, table: string, rows: number): Promise<void> {
  const count = Number(await scalar(conn, `SELECT count(*) FROM ${table}`));
  if (count !== rows) throw new Error(`expected ${rows} rows in ${table}, got ${count}`);
}

/** 1M rows of integer, varchar, double, timestamp, decimal and list columns. */
async function createMixedTable(conn: DuckDBConnection, rows: number): Promise<void> {
  await conn.run(`
    CREATE OR REPLACE TABLE mixed AS
    SELECT
      i::INTEGER AS id,
      'name-' || i AS name,
      (i * 1.5)::DOUBLE AS score,
      TIMESTAMP '2024-01-01 00:00:00' + to_seconds(i) AS ts,
      ((i % 100000) / 100)::DECIMAL(18, 2) AS amount,
      [i::INTEGER, (i + 1)::INTEGER, (i + 2)::INTEGER] AS tags
    FROM range(${rows}) t(i)
  `);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function ingest(name: string, title: string, source: (ctx: ScenarioContext) => string): Scenario {
  return {
    name,
    title,
    rounds: 5,
    warmup: true,
    metrics: [],
    async run(ctx) {
      await ctx.conn.run(`CREATE OR REPLACE TABLE ingested AS SELECT * FROM ${source(ctx)}`);
      return {};
    },
    async verify(ctx) {
      await expectCount(ctx.conn, "ingested", ctx.rows);
    },
  };
}

export const SCENARIOS: Scenario[] = [
  ingest(
    "ingest-json",
    "Create table from JSON (read_json_auto)",
    (ctx) => `read_json_auto(${sqlString(join(ctx.dataDir, "rows.ndjson"))})`,
  ),
  ingest(
    "ingest-csv",
    "Create table from CSV (read_csv)",
    (ctx) => `read_csv(${sqlString(join(ctx.dataDir, "rows.csv"))})`,
  ),
  {
    name: "parquet-write",
    title: "Parquet write (COPY TO)",
    rounds: 5,
    warmup: true,
    metrics: [],
    async setup(ctx) {
      await createMixedTable(ctx.conn, ctx.rows);
    },
    async run(ctx, index) {
      const file = join(ctx.workDir, `out-${index}.parquet`);
      await ctx.conn.run(`COPY mixed TO ${sqlString(file)} (FORMAT parquet)`);
      return {};
    },
    async verify(ctx) {
      await expectCount(ctx.conn, `read_parquet(${sqlString(join(ctx.workDir, "out-0.parquet"))})`, ctx.rows);
    },
  },
  {
    name: "read-all",
    title: "Query and read all (runAndReadAll + getRowObjects)",
    rounds: 5,
    warmup: true,
    metrics: [
      { key: "queryMs", label: "runAndReadAll (ms)", aggregate: "median" },
      { key: "rowsMs", label: "getRowObjects (ms)", aggregate: "median" },
    ],
    async setup(ctx) {
      await createMixedTable(ctx.conn, ctx.rows);
    },
    async run(ctx) {
      const t0 = performance.now();
      const reader = await ctx.conn.runAndReadAll("SELECT * FROM mixed");
      const t1 = performance.now();
      const rows = reader.getRowObjects();
      const t2 = performance.now();
      if (rows.length !== ctx.rows) throw new Error(`expected ${ctx.rows} rows, got ${rows.length}`);
      return { queryMs: t1 - t0, rowsMs: t2 - t1 };
    },
  },
  {
    name: "prepared",
    title: `Prepared statement (prepare once, bind and run ${PREPARED_ITERATIONS} times)`,
    rounds: 5,
    warmup: true,
    metrics: [{ key: "perCallUs", label: "Per call (us)", aggregate: "median" }],
    async setup(ctx) {
      await ctx.conn.run(
        "CREATE OR REPLACE TABLE lookup AS SELECT i::INTEGER AS id, 'name-' || i AS name FROM range(1000) t(i)",
      );
    },
    async run(ctx) {
      const statement = await ctx.conn.prepare("SELECT id, name FROM lookup WHERE id = $1");
      try {
        const t0 = performance.now();
        for (let i = 0; i < PREPARED_ITERATIONS; i++) {
          const id = i % 1000;
          statement.bindInteger(1, id);
          const reader = await statement.runAndReadAll();
          const rows = reader.getRows();
          if (rows.length !== 1 || rows[0]?.[0] !== id) {
            throw new Error(`iteration ${i}: expected one row with id ${id}, got ${JSON.stringify(rows)}`);
          }
        }
        return { perCallUs: ((performance.now() - t0) * 1000) / PREPARED_ITERATIONS };
      } finally {
        statement.destroySync();
      }
    },
  },
  {
    name: "event-loop-lag",
    title: `Event-loop lag during a long query (${LAG_INTERVAL_MS} ms interval)`,
    // 4 rounds give 8 pairs, the fewest whose signed-rank test can reach p < 0.01 (1/256).
    rounds: 4,
    warmup: false,
    metrics: [
      { key: "maxGapMs", label: "Max gap (ms)", aggregate: "max" },
      { key: "p99GapMs", label: "p99 gap (ms)", aggregate: "median" },
      { key: "ticks", label: "Ticks", aggregate: "median" },
    ],
    async run(ctx) {
      const ticks: number[] = [];
      const interval = setInterval(() => ticks.push(performance.now()), LAG_INTERVAL_MS);
      try {
        // Let the timer settle so the first gap is not set-up noise.
        await Bun.sleep(LAG_INTERVAL_MS * 3);
        ticks.length = 0;
        ticks.push(performance.now());
        await ctx.conn.runAndReadAll(`SELECT sum(hash(i)) FROM range(${ctx.lagRows}) t(i)`);
        ticks.push(performance.now());
      } finally {
        clearInterval(interval);
      }
      const gaps = ticks
        .slice(1)
        .map((t, i) => t - (ticks[i] ?? t))
        .sort((a, b) => a - b);
      return { maxGapMs: gaps.at(-1) ?? 0, p99GapMs: percentile(gaps, 99), ticks: ticks.length };
    },
  },
];

export const SCENARIO_NAMES = SCENARIOS.map((s) => s.name);
