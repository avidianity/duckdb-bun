// Concurrency stress through the public API: many connections on one instance run
// mixed queries, prepared statements, streamed reads, appenders, scalar functions
// that DuckDB's threads call back into JavaScript, interrupted queries, connections
// and statements closed while their calls run, bursts of concurrent calls, and
// Workers that load the package and exit normally, all at once for a bounded time.
//
// After the load it waits for the job pool's idle timeout and sends single calls
// across the moment idle threads exit, then a burst larger than the pool left
// behind (docs/adr/0006).
//
// It checks that every result is right, that every error is one DuckDB or the
// binding reports for that operation, that nothing hangs, that no job is left in
// flight, that every native handle is freed again, that the event loop never blocks,
// and, on Linux, that idle pool threads exit.
//
//   STRESS_SEED=<n>     repeats a run's random choices (each run prints its seed)
//   STRESS_SECONDS=<n>  seconds of mixed load, 8 by default
//
// The interleaving across threads still differs between runs; the seed fixes each
// lane's choices of queries, sizes and delays.

import { expect, test } from "bun:test";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import {
  type DuckDBConnection,
  DuckDBInstance,
  type DuckDBPreparedStatement,
  DuckDBScalarFunction,
  diagnostics,
  INTEGER,
} from "../../src/neo.ts";
import { settleHandles } from "./settle-handles.ts";
import { EventLoopProbe, numberFrom, poolThreads, quantile, Random, seedFrom } from "./workload.ts";

const SEED = seedFrom("STRESS_SEED");
const LOAD_MS = numberFrom("STRESS_SECONDS", 8) * 1000;
/** `IDLE_TIMEOUT` in native/src/pool.rs. */
const POOL_IDLE_TIMEOUT_MS = 10_000;
/**
 * A native call that blocks the JS thread shows up as one gap as long as the call.
 * The p99 bound lives in tests/heavy/event-loop-stress.test.ts, the bench gate and
 * the soak: here the JS thread also converts every lane's rows while 24 Workers
 * compete for the cores, so on the 3-core macOS runner its p99 measured 108 ms
 * with a largest gap of 128 ms, which is CPU contention, not a blocking call.
 */
const MAX_GAP_MS = 1000;
/** A lane still running this long after the load ends is reported as hung. */
const HANG_MS = 60_000;
/** Far below the shim's 4095 contexts per process (native/ABI.md, `dbs_init`). */
const MAX_WORKERS = 24;
/** DuckDB gets every core but one on the shared instance, so the JS thread keeps a core. */
const THREADS = String(Math.max(1, availableParallelism() - 1));
const TABLE_ROWS = 100_000;
/**
 * The longest pause between a lane's steps. Without pauses the lanes keep the JS thread
 * busy converting results and running callbacks, and the timer then measures that work
 * rather than a JS thread that waits for a query.
 */
const THINK_MS = 20;
/** About a second of work on the long queries, which interrupt and close stop. */
const INTERRUPTED_QUERY = "SELECT sum(hash(i)) FROM range(5_000_000_000) t(i)";
const CLOSED_QUERY = "SELECT sum(hash(i)) FROM range(20_000_000) t(i)";
const CLOSED_STREAM_ROWS = 2_000_000;
const WORKER = join(import.meta.dir, "fixtures", "concurrency-worker.ts");

/** Errors an operation may meet when its connection, statement or instance is closed under it. */
const CLOSED_ERRORS = [
  /^INTERRUPT Error: Interrupted!$/,
  /connection disconnected/,
  /^Connection Error: /,
  /^(Pending result|Result) destroyed$/,
  /^Invalid Input Error: Attempting to execute a prepared statement after its connection was closed!$/,
];

const failures: string[] = [];
const expectedErrors = new Map<string, number>();

function fail(lane: string, message: string): void {
  failures.push(`${lane}: ${message}`);
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.constructor.name}: ${value.message}`;
  return `${typeof value} ${String(value)}`;
}

function check(lane: string, what: string, actual: unknown, expected: unknown): void {
  if (!Bun.deepEquals(actual, expected, true)) {
    fail(lane, `${what}: got ${Bun.inspect(actual)}, expected ${Bun.inspect(expected)}`);
  }
}

/** Records `error` as expected when its message matches `allowed`, and as a failure otherwise. */
function expectError(lane: string, what: string, error: unknown, allowed: readonly RegExp[]): void {
  const pattern = error instanceof Error ? allowed.find((p) => p.test(error.message)) : undefined;
  if (!pattern || !(error instanceof Error) || error.constructor !== Error) {
    fail(lane, `${what}: unexpected ${describe(error)}`);
    return;
  }
  expectedErrors.set(pattern.source, (expectedErrors.get(pattern.source) ?? 0) + 1);
}

/** Runs `work` and expects it to reject with an error `allowed` matches. */
async function rejects(lane: string, what: string, work: () => Promise<unknown>, allowed: readonly RegExp[]) {
  try {
    const value = await work();
    fail(lane, `${what}: resolved with ${Bun.inspect(value)}, expected an error`);
  } catch (error) {
    expectError(lane, what, error, allowed);
  }
}

const triangle = (n: number) => (BigInt(n) * BigInt(n - 1)) / 2n;

async function first(connection: DuckDBConnection, sql: string): Promise<unknown[]> {
  return (await connection.runAndReadAll(sql)).getRows()[0] ?? [];
}

interface Lane {
  name: string;
  /** The operation running now, reported when the lane hangs. */
  op: string;
  iterations: number;
  done: boolean;
}

const lanes: Lane[] = [];

/**
 * Runs `step` until `deadline`, with a pause of up to THINK_MS after each step, as a
 * service waits between requests. An error `step` did not expect fails the run and ends the lane.
 */
async function lane(name: string, deadline: number, rand: Random, step: (state: Lane) => Promise<void>) {
  const state: Lane = { name, op: "start", iterations: 0, done: false };
  lanes.push(state);
  try {
    while (performance.now() < deadline) {
      await step(state);
      state.iterations++;
      state.op = "pause";
      await Bun.sleep(rand.int(0, THINK_MS));
    }
  } catch (error) {
    fail(name, `during ${state.op}: unexpected ${describe(error)}${error instanceof Error ? `\n${error.stack}` : ""}`);
  } finally {
    state.done = true;
  }
}

/** Resolves when `work` settles, or rejects naming every lane still running after `ms`. */
async function watchdog(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const running = lanes.filter((l) => !l.done).map((l) => `${l.name} in ${l.op} after ${l.iterations} iterations`);
      reject(new Error(`hung for ${ms} ms: ${running.join("; ")}; diagnostics ${Bun.inspect(diagnostics())}`));
    }, ms);
  });
  try {
    await Promise.race([work, hung]);
  } finally {
    clearTimeout(timer);
  }
}

/** One of several queries with a known answer, or a query that fails with a known error. */
async function mixed(name: string, connection: DuckDBConnection, random: Random, state: Lane): Promise<void> {
  const kind = random.int(0, 5);
  state.op = `mixed ${kind}`;
  if (kind === 0) {
    const n = random.int(0, 3_000_000);
    check(name, `sum of range(${n})`, await first(connection, `SELECT sum(i)::BIGINT FROM range(${n}) t(i)`), [
      n === 0 ? null : triangle(n),
    ]);
  } else if (kind === 1) {
    const m = random.int(1, 97);
    check(name, `rows of t divisible by ${m}`, await first(connection, `SELECT count(*) FROM t WHERE i % ${m} = 0`), [
      BigInt(Math.ceil(TABLE_ROWS / m)),
    ]);
  } else if (kind === 2) {
    const k = random.int(0, 300);
    check(name, `repeat ${k}`, await first(connection, `SELECT repeat('ab', ${k}), length(repeat('ab', ${k}))`), [
      "ab".repeat(k),
      BigInt(2 * k),
    ]);
  } else if (kind === 3) {
    const k = random.int(1, 50);
    const reader = await connection.runAndReadAll(
      `SELECT [i::INTEGER, (i * 2)::INTEGER] AS l, {'a': i::INTEGER, 'b': 'x' || i} AS s FROM range(${k}) t(i) ORDER BY i`,
    );
    check(
      name,
      `nested rows of range(${k})`,
      reader.getRowObjectsJson(),
      Array.from({ length: k }, (_, i) => ({ l: [i, i * 2], s: { a: i, b: `x${i}` } })),
    );
  } else if (kind === 4) {
    const k = random.int(0, 4000);
    const expected = new Date(Date.UTC(2026, 0, 1 + k)).toISOString().slice(0, 10);
    check(name, `date plus ${k}`, (await first(connection, `SELECT (DATE '2026-01-01' + ${k})::VARCHAR`))[0], expected);
  } else {
    const k = random.int(0, 1_000_000);
    await rejects(name, `missing table ${k}`, () => connection.runAndReadAll(`SELECT * FROM missing_${k}`), [
      /^Catalog Error: Table with name missing_\d+ does not exist!/,
    ]);
  }
}

test(
  "concurrent calls on one instance and in Workers stay correct, settle, free their handles and keep the event loop free",
  async () => {
    console.log(`concurrency stress: seed ${SEED} (STRESS_SEED=${SEED} repeats it), ${LOAD_MS / 1000} s of load`);
    const random = new Random(SEED);
    const baseline = diagnostics().liveHandles;
    const callbacksBefore = diagnostics().callbacks.posted;
    const probe = new EventLoopProbe();
    const gaps: number[] = [];

    const instance = await DuckDBInstance.create(":memory:", { threads: THREADS });
    const setup = await instance.connect();
    await setup.run(`CREATE TABLE t AS SELECT i FROM range(${TABLE_ROWS}) r(i)`);
    const closedQueryValue = (await first(setup, CLOSED_QUERY))[0];

    const connections: DuckDBConnection[] = [];
    const connect = async () => {
      const connection = await instance.connect();
      connections.push(connection);
      return connection;
    };
    const statements: DuckDBPreparedStatement[] = [];
    const burstConnections = await Promise.all(Array.from({ length: 16 }, connect));

    /** Fires `size` queries at once across the burst connections, more than the pool has idle. */
    async function burst(name: string, size: number, rand: Random): Promise<void> {
      await Promise.all(
        Array.from({ length: size }, async (_, index) => {
          const connection = burstConnections[index % burstConnections.length] as DuckDBConnection;
          const x = rand.int(0, 1_000_000);
          const rows = rand.int(1000, 200_000);
          check(
            name,
            `burst query ${index}`,
            await first(connection, `SELECT ${x}::INTEGER * 2, count(*) FROM range(${rows}) t(i)`),
            [2 * x, BigInt(rows)],
          );
        }),
      );
    }

    probe.start();
    const deadline = performance.now() + LOAD_MS;
    const work: Promise<void>[] = [];
    let laneIndex = 0;
    const spawn = (name: string, body: (rand: Random) => Promise<(state: Lane) => Promise<void>>) => {
      const rand = random.fork(laneIndex++);
      work.push(body(rand).then((step) => lane(name, deadline, rand, step)));
    };

    for (let i = 0; i < 4; i++) {
      spawn(`mixed ${i}`, async (rand) => {
        const connection = await connect();
        return (state) => mixed(`mixed ${i}`, connection, rand, state);
      });
    }

    for (let i = 0; i < 2; i++) {
      const name = `prepared ${i}`;
      spawn(name, async (rand) => {
        const connection = await connect();
        const product = await connection.prepare("SELECT $1::BIGINT * $2::BIGINT AS p, $3::VARCHAR || '!' AS s");
        const below = await connection.prepare("SELECT count(*) FROM t WHERE i < $1");
        statements.push(product, below);
        return async (state) => {
          const kind = rand.int(0, 3);
          state.op = `prepared ${kind}`;
          if (kind === 0) {
            const a = rand.int(-1_000_000, 1_000_000);
            const b = rand.int(-1_000_000, 1_000_000);
            product.bindBigInt(1, BigInt(a));
            product.bindBigInt(2, BigInt(b));
            product.bindVarchar(3, `v${a}`);
            check(name, `product ${a} ${b}`, (await product.runAndReadAll()).getRows(), [
              [BigInt(a) * BigInt(b), `v${a}!`],
            ]);
          } else if (kind === 1) {
            const n = rand.int(0, TABLE_ROWS + 10);
            below.bindInteger(1, n);
            let count: unknown;
            for await (const chunk of await below.stream()) count ??= chunk.getRows()[0]?.[0];
            check(name, `rows of t below ${n}`, count, BigInt(Math.min(n, TABLE_ROWS)));
          } else if (kind === 2) {
            const n = rand.int(0, TABLE_ROWS + 10);
            below.bind([n]);
            check(name, `rows of t below ${n}`, (await below.runAndReadAll()).getRows(), [
              [BigInt(Math.min(n, TABLE_ROWS))],
            ]);
          } else {
            product.bindVarchar(1, "not a number");
            product.bindBigInt(2, 1n);
            product.bindVarchar(3, "x");
            await rejects(name, "a bad bind", () => product.runAndReadAll(), [/^Conversion Error: /]);
          }
        };
      });
    }

    for (let i = 0; i < 2; i++) {
      const name = `stream ${i}`;
      spawn(name, async (rand) => {
        const connection = await connect();
        return async (state) => {
          const n = rand.int(0, 200_000);
          const how = rand.int(0, 2);
          state.op = `stream ${how} of ${n} rows`;
          const result = await connection.stream(`SELECT i, i % 7 AS m FROM range(${n}) t(i)`);
          let rows = 0;
          let sum = 0n;
          if (how === 0) {
            for await (const chunk of result) {
              rows += chunk.rowCount;
              for (const [value] of chunk.getRows()) sum += value as bigint;
            }
          } else if (how === 1) {
            for (;;) {
              const chunk = await result.fetchChunk();
              if (!chunk || chunk.rowCount === 0) break;
              rows += chunk.rowCount;
              for (const [value] of chunk.getRows()) sum += value as bigint;
            }
          } else {
            // Stops after one chunk. From DuckDB 2.0 an unfinished streaming result blocks its
            // connection's next query until it is drained or closed.
            await result.fetchChunk();
            result.closeSync();
            return;
          }
          check(name, `streamed rows of range(${n})`, [rows, sum], [n, triangle(n)]);
        };
      });
    }

    for (let i = 0; i < 2; i++) {
      const name = `appender ${i}`;
      spawn(name, async (rand) => {
        const connection = await connect();
        await connection.run(`CREATE TABLE appended_${i} (v INTEGER, s VARCHAR)`);
        let count = 0n;
        let sum = 0n;
        return async (state) => {
          const k = rand.int(1, 3000);
          state.op = `append ${k} rows`;
          const appender = await connection.createAppender(`appended_${i}`);
          for (let j = 0; j < k; j++) {
            appender.appendInteger(j);
            appender.appendVarchar(`r${j}`);
            appender.endRow();
          }
          appender.flushSync();
          appender.closeSync();
          count += BigInt(k);
          sum += triangle(k);
          state.op = "read appended rows";
          check(name, "appended rows", await first(connection, `SELECT count(*), sum(v)::BIGINT FROM appended_${i}`), [
            count,
            sum,
          ]);
        };
      });
    }

    for (let i = 0; i < 2; i++) {
      const name = `callback ${i}`;
      spawn(name, async (rand) => {
        const connection = await connect();
        connection.registerScalarFunction(
          DuckDBScalarFunction.create({
            name: `js_inc_${i}`,
            returnType: INTEGER,
            parameterTypes: [INTEGER],
            mainFunction: (_info, input, output) => {
              const vector = input.getColumnVector(0);
              for (let row = 0; row < input.rowCount; row++) {
                const value = vector.getItem(row) as number;
                if (value === -1) throw new Error("stress boom");
                output.setItem(row, value + 1);
              }
              output.flush();
            },
          }),
        );
        return async (state) => {
          if (rand.int(0, 7) === 0) {
            state.op = "failing callback";
            await rejects(
              name,
              "a callback that throws",
              () =>
                connection.runAndReadAll(
                  `SELECT sum(js_inc_${i}(CASE WHEN i = 5000 THEN -1 ELSE i END::INTEGER)) FROM range(10000) t(i)`,
                ),
              [/stress boom/],
            );
            return;
          }
          const n = rand.int(1, 50_000);
          state.op = `callback over ${n} rows`;
          check(
            name,
            `sum of js_inc over range(${n})`,
            await first(connection, `SELECT sum(js_inc_${i}(i::INTEGER))::BIGINT FROM range(${n}) t(i)`),
            [triangle(n) + BigInt(n)],
          );
        };
      });
    }

    spawn("interrupt", async (rand) => {
      const connection = await connect();
      return async (state) => {
        state.op = "interrupted query";
        const every = rand.int(5, 25);
        const timer = setInterval(() => connection.interrupt(), every);
        try {
          await rejects("interrupt", "an interrupted query", () => connection.runAndReadAll(INTERRUPTED_QUERY), [
            /^INTERRUPT Error: Interrupted!$/,
          ]);
        } finally {
          clearInterval(timer);
        }
        state.op = "query after interrupt";
        check("interrupt", "a query after the interrupt", await first(connection, "SELECT 42"), [42]);
      };
    });

    for (let i = 0; i < 2; i++) {
      const name = `close ${i}`;
      spawn(name, async (rand) => async (state) => {
        const own = rand.int(0, 3) === 0 ? await DuckDBInstance.create(":memory:", { threads: "1" }) : null;
        const connection = await (own ?? instance).connect();
        const statement = await connection.prepare("SELECT sum(hash(i)) FROM range($1) t(i)");
        statement.bindBigInt(1, 20_000_000n);
        const action = rand.pick(own ? ["instance", "connection", "statement"] : ["connection", "statement"]);
        state.op = `close the ${action} under running calls`;
        // allSettled takes each outcome at once, so a call that fails before the close is not an unhandled rejection.
        const calls: [string, Promise<unknown>, unknown][] = [
          ["query", connection.runAndReadAll(CLOSED_QUERY).then((r) => r.getRows()[0]?.[0]), closedQueryValue],
          ["prepared", statement.runAndReadAll().then((r) => r.getRows()[0]?.[0]), closedQueryValue],
          [
            "stream",
            (async () => {
              let rows = 0;
              for await (const chunk of await connection.stream(`SELECT i FROM range(${CLOSED_STREAM_ROWS}) t(i)`)) {
                rows += chunk.rowCount;
              }
              return rows;
            })(),
            CLOSED_STREAM_ROWS,
          ],
        ];
        const settled = Promise.allSettled(calls.map(([, promise]) => promise));
        await Bun.sleep(rand.int(0, 30));
        if (action === "instance") own?.closeSync();
        else if (action === "connection") connection.closeSync();
        else statement.destroySync();
        const outcomes = await settled;
        outcomes.forEach((outcome, index) => {
          const [call, , expected] = calls[index] as [string, Promise<unknown>, unknown];
          const what = `${call} after closing the ${action}`;
          if (outcome.status === "fulfilled") check(name, what, outcome.value, expected);
          else expectError(name, what, outcome.reason, CLOSED_ERRORS);
        });
        statement.destroySync();
        connection.closeSync();
        own?.closeSync();
      });
    }

    spawn("burst", async (rand) => async (state) => {
      const size = rand.int(24, 96);
      state.op = `burst of ${size}`;
      await burst("burst", size, rand);
      await Bun.sleep(rand.int(50, 400));
    });

    let workers = 0;
    spawn("workers", async (rand) => async (state) => {
      if (workers >= MAX_WORKERS) {
        state.op = "waiting for the deadline";
        await Bun.sleep(100);
        return;
      }
      state.op = `workers ${workers} and ${workers + 1}`;
      await Promise.all(
        [0, 1].map(async () => {
          workers++;
          const rows = rand.int(1000, 100_000);
          const worker = new Worker(WORKER, { argv: [String(rows)] });
          const [message, code] = await Promise.all([
            new Promise<Record<string, unknown>>((resolve, reject) => {
              worker.addEventListener("message", (event) => resolve(event.data), { once: true });
              worker.addEventListener("error", (event) => reject(new Error(`worker error: ${event.message}`)));
            }),
            new Promise<number>((resolve) => worker.addEventListener("close", (event) => resolve(event.code))),
          ]);
          check("workers", `worker over ${rows} rows`, message, {
            callback: triangle(rows) + BigInt(rows),
            prepared: BigInt(rows) * 3n,
            streamed: triangle(rows),
            inFlight: 0,
          });
          check("workers", "worker exit code", code, 0);
        }),
      );
    });

    await watchdog(Promise.all(work), LOAD_MS + HANG_MS);
    gaps.push(...probe.take());
    const afterLoad = diagnostics();
    expect(afterLoad.jobs.inFlight).toBe(0);
    const poolAfterLoad = poolThreads();

    // Single calls across the moment idle pool threads time out and exit.
    await Bun.sleep(POOL_IDLE_TIMEOUT_MS - 500);
    probe.take();
    const edge = random.fork(1000);
    const edgeConnection = burstConnections[0] as DuckDBConnection;
    const edgeEnd = performance.now() + 1500;
    let edgeCalls = 0;
    while (performance.now() < edgeEnd) {
      const x = edge.int(0, 1_000_000);
      check("idle edge", `single call ${edgeCalls}`, await first(edgeConnection, `SELECT ${x}::INTEGER + 1`), [x + 1]);
      edgeCalls++;
      await Bun.sleep(edge.int(0, 30));
    }
    // A burst larger than what the pool kept.
    await watchdog(burst("burst after idle", 128, edge), HANG_MS);
    gaps.push(...probe.take());
    probe.stop();
    expect(diagnostics().jobs.inFlight).toBe(0);

    for (const statement of statements) statement.destroySync();
    for (const connection of connections) connection.closeSync();
    setup.closeSync();
    instance.closeSync();

    // Idle pool threads exit after the timeout (Linux lists thread names in procfs).
    let poolAtEnd = poolThreads();
    const poolDeadline = performance.now() + POOL_IDLE_TIMEOUT_MS + 5000;
    while (poolAtEnd !== null && poolAtEnd > 0 && performance.now() < poolDeadline) {
      await Bun.sleep(250);
      poolAtEnd = poolThreads();
    }

    const excess = await settleHandles(baseline);

    const end = diagnostics();
    const iterations = lanes.map((l) => `${l.name} ${l.iterations}`).join(", ");
    console.log(`lanes: ${iterations}; workers ${workers}; single calls at the idle edge ${edgeCalls}`);
    console.log(`expected errors: ${Bun.inspect(Object.fromEntries(expectedErrors))}`);
    console.log(
      `event loop: ${gaps.length} ticks, p99 gap ${quantile(gaps, 0.99).toFixed(1)} ms, max gap ${Math.max(...gaps).toFixed(1)} ms`,
    );
    console.log(
      `jobs ${end.jobs.started}, callbacks posted ${end.callbacks.posted - callbacksBefore}, native threads peak ${end.nativeThreads.peak}, pool threads after the load ${poolAfterLoad ?? "n/a"}, at the end ${poolAtEnd ?? "n/a"}`,
    );

    expect(failures.slice(0, 20)).toEqual([]);
    for (const l of lanes) expect(`${l.name} ${l.iterations > 0 ? "ran" : "never ran"}`).toBe(`${l.name} ran`);
    expect(end.callbacks.posted - callbacksBefore).toBeGreaterThan(0);
    expect(end.jobs.inFlight).toBe(0);
    expect(excess).toEqual([]);
    expect(Math.max(...gaps)).toBeLessThan(MAX_GAP_MS);
    if (poolAtEnd !== null) expect(poolAtEnd).toBe(0);
  },
  numberFrom("STRESS_SECONDS", 8) * 1000 + 2 * POOL_IDLE_TIMEOUT_MS + 3 * 60_000,
);
