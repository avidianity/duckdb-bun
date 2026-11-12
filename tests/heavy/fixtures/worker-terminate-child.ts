// Child process for worker-terminate.test.ts, so a crash is observable as an exit
// signal. It starts Workers that use duckdb-bun and terminates each one while its
// native work is in flight, then prints one JSON line with what it measured.
// Usage: bun worker-terminate-child.ts <rounds per mode>
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { DuckDBInstance, diagnostics } from "../../../src/neo.ts";

const ROUNDS = Number(process.argv[2] ?? 20);
const WORKER = new URL("./worker-terminate-worker.ts", import.meta.url).href;
/** How long the native threads of terminated Workers get to wind down. */
const SETTLE_MS = 60_000;

/** OS threads of this process: DuckDB's scheduler threads of a database nobody closed show up here. */
function osThreads(): number {
  if (process.platform === "linux") return readdirSync("/proc/self/task").length;
  const ps = spawnSync("ps", ["-M", "-p", String(process.pid)], { encoding: "utf8" });
  return ps.stdout.trim().split("\n").length - 1;
}

function counters() {
  const { nativeThreads, jobs, callbacks } = diagnostics();
  return { running: nativeThreads.running, jobs, callbacks };
}

/** A pseudo-random delay, the same sequence every run, so a failure can be replayed. */
let seed = 42;
function delay(min: number, max: number): number {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return min + (seed % (max - min));
}

const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();
let mainQueries = 0;

async function mainStillWorks(): Promise<void> {
  const reader = await connection.runAndReadAll("SELECT 42 AS answer");
  if (reader.getRowObjects()[0]?.answer !== 42) throw new Error("the main thread's query returned a wrong answer");
  mainQueries++;
}

/** Starts a Worker in `mode` and resolves once it has closed. */
async function round(mode: string): Promise<void> {
  const worker = new Worker(WORKER, { argv: [mode] });
  const closed = new Promise<void>((resolve) => worker.addEventListener("close", () => resolve()));
  const errors: string[] = [];
  worker.addEventListener("error", (event) => errors.push(String(event.message)));
  const ready = new Promise<void>((resolve) =>
    worker.addEventListener("message", (event) => event.data === "ready" && resolve()),
  );
  if (mode === "early") {
    // Before or while the Worker loads the bindings.
    await Bun.sleep(delay(0, 120));
    worker.terminate();
  } else if (mode === "end") {
    // The Worker ends on its own.
  } else {
    await ready;
    await Bun.sleep(delay(20, 400));
    worker.terminate();
  }
  await closed;
  if (errors.length > 0) throw new Error(`Worker in ${mode} mode failed: ${errors.join("; ")}`);
}

// One Worker that ends on its own first, so threads Bun keeps after the first Worker count in the baseline.
await round("end");
await mainStillWorks();
const baseline = { counters: counters(), threads: osThreads() };

const modes = ["query", "callback", "stream", "early", "end"];
for (let index = 0; index < ROUNDS; index++) {
  for (const mode of modes) {
    await round(mode);
    await mainStillWorks();
  }
}

const deadline = Date.now() + SETTLE_MS;
while (diagnostics().nativeThreads.running > baseline.counters.running && Date.now() < deadline) await Bun.sleep(50);
await mainStillWorks();

console.log(
  JSON.stringify({
    workers: ROUNDS * modes.length + 1,
    mainQueries,
    baseline,
    final: { counters: counters(), threads: osThreads() },
  }),
);
