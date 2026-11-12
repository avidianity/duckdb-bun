// Differential parity harness for the public `@duckdb/node-api` surface.
//
// A scenario is an async function written once against the official API type. The
// harness runs it against the official `@duckdb/node-api` (the truth) and against
// ours (`src/neo.ts`), one after the other, normalizes both outcomes to plain data,
// and asserts they are equal. An outcome is either the scenario's return value or
// the error it threw, as `{ class: error.constructor.name, message: error.message }`.
//
// Scenarios that can crash or hang the process run with `isolate: true`: each
// implementation then runs in its own `bun test` child process, filtered to that one
// test, which writes its outcome to a file. A child that dies or overruns its time
// budget becomes a `crashed` or `hung` outcome instead of taking the suite down.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as officialApi from "@duckdb/node-api";
import * as oursApi from "../../src/neo.ts";

export type Api = typeof officialApi;
export type Impl = "official" | "ours";

const APIS: Record<Impl, Api> = {
  official: officialApi,
  // Ours re-exports the vendored upstream sources, so it has the official shape;
  // scenarios are typed against the published declarations, the public contract.
  ours: oursApi as unknown as Api,
};

const REPO_ROOT = join(import.meta.dir, "../..");
const CHILD_IMPL = process.env.PARITY_CHILD_IMPL as Impl | undefined;
const CHILD_OUT = process.env.PARITY_CHILD_OUT;
const CHILD_TEST = process.env.PARITY_CHILD_TEST;

/** Skip reason for tests that download DuckDB extensions. */
export const OFFLINE = process.env.DUCKDB_BUN_OFFLINE === "1";

export interface ScenarioContext {
  impl: Impl;
  /** A fresh directory for this run only, removed afterwards; shows up as `<tmp>` in outcomes. */
  tmp: string;
  /** A directory kept for the whole process, one per implementation; shows up as `<shared>` in outcomes. */
  shared: string;
}

export type Scenario = (api: Api, ctx: ScenarioContext) => Promise<unknown>;

export interface ParityOptions {
  /** Per-test timeout in milliseconds. */
  timeout?: number;
  /** Run each implementation in its own child process (crash and hang containment). */
  isolate?: boolean;
  /** Skip the test when true. */
  skip?: boolean;
  /** Assert the official outcome kind, so a broken scenario cannot pass by failing on both sides alike. */
  official?: "ok" | "error";
}

export type Outcome =
  | { ok: unknown }
  | { error: { class: string; message: string } }
  | { crashed: string; line: string }
  | { hung: string };

/** Error shape compared across implementations. */
export function describeError(err: unknown): { class: string; message: string } {
  if (err instanceof Error) return { class: err.constructor.name, message: err.message };
  return { class: typeof err, message: String(err) };
}

/** Runs one step of a scenario and records its result or error, for scenarios that compare several steps. */
export async function capture(
  fn: () => unknown,
): Promise<{ ok: unknown } | { error: { class: string; message: string } }> {
  try {
    return { ok: await fn() };
  } catch (err) {
    return { error: describeError(err) };
  }
}

/** Opens an instance and a connection, runs `fn`, and closes both. */
export async function withConnection<T>(
  api: Api,
  fn: (connection: officialApi.DuckDBConnection, instance: officialApi.DuckDBInstance) => Promise<T>,
  path = ":memory:",
  options?: Record<string, string>,
): Promise<T> {
  const instance = await api.DuckDBInstance.create(path, options);
  const connection = await instance.connect();
  try {
    return await fn(connection, instance);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

type Replace = (text: string) => string;

/**
 * Converts any value to plain, JSON-safe comparable data: bigint to `"<digits>n"`,
 * non-finite numbers and -0 to tagged text, byte arrays
 * to hex, dates to ISO text, and class instances (DuckDB value and type objects) to
 * `{ class, string, fields }`, where `string` is the instance's `toString()`.
 */
export function normalize(value: unknown, replace: Replace = (s) => s, depth = 0): unknown {
  if (depth > 32) return "<too deep>";
  if (value === undefined) return "<undefined>";
  if (value === null) return null;
  switch (typeof value) {
    case "bigint":
      return `${value}n`;
    case "string":
      return replace(value);
    case "number":
      // JSON (the child-process channel) cannot carry these.
      return Number.isFinite(value) && !Object.is(value, -0)
        ? value
        : `<number ${Object.is(value, -0) ? "-0" : value}>`;
    case "boolean":
      return value;
    case "function":
      return "<function>";
    case "symbol":
      return value.toString();
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { class: value.constructor.name, hex: Buffer.from(bytes).toString("hex") };
  }
  if (value instanceof Date) {
    return { class: "Date", iso: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString() };
  }
  if (value instanceof Error) return { error: describeError(value) };
  if (Array.isArray(value)) return value.map((item) => normalize(item, replace, depth + 1));
  const object = value as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(object)) fields[key] = normalize(field, replace, depth + 1);
  const proto = Object.getPrototypeOf(object);
  if (proto === null || proto === Object.prototype) return fields;
  let text: string;
  try {
    text = replace(String(object));
  } catch (err) {
    text = `<toString threw ${describeError(err).message}>`;
  }
  return { class: object.constructor?.name ?? "<anonymous>", string: text, fields };
}

const sharedDirs = new Map<Impl, string>();
process.on("exit", () => {
  for (const dir of sharedDirs.values()) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function sharedDir(impl: Impl): string {
  let dir = sharedDirs.get(impl);
  if (!dir) {
    dir = makeDir(`duckdb-bun-parity-${impl}-shared-`);
    sharedDirs.set(impl, dir);
  }
  return dir;
}

async function runInProcess(impl: Impl, scenario: Scenario): Promise<Outcome> {
  const tmp = makeDir(`duckdb-bun-parity-${impl}-`);
  const shared = sharedDir(impl);
  const replace: Replace = (text) => text.replaceAll(tmp, "<tmp>").replaceAll(shared, "<shared>");
  try {
    const value = await scenario(APIS[impl], { impl, tmp, shared });
    return { ok: normalize(value, replace) };
  } catch (err) {
    return { error: normalize(describeError(err), replace) as { class: string; message: string } };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

async function runInChild(file: string, name: string, impl: Impl, budgetMs: number): Promise<Outcome> {
  const dir = makeDir("duckdb-bun-parity-child-");
  const out = join(dir, "outcome.json");
  try {
    const child = Bun.spawn(
      [process.execPath, "test", file, "-t", `^${escapeRegex(name)}$`, `--timeout=${budgetMs * 2}`],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PARITY_CHILD_IMPL: impl, PARITY_CHILD_OUT: out, PARITY_CHILD_TEST: name },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, budgetMs);
    const [, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    clearTimeout(timer);
    if (existsSync(out)) return JSON.parse(readFileSync(out, "utf8")) as Outcome;
    if (killed) return { hung: `no outcome after ${budgetMs} ms` };
    const lines = stderr.split("\n");
    const line =
      lines.find((l) => /fatal signal|panic|Segmentation fault|error:/i.test(l)) ?? lines.find((l) => l.trim()) ?? "";
    return { crashed: child.signalCode ?? `exit ${child.exitCode}`, line: line.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Returns a `parity(name, scenario, options)` test registrar bound to the calling test file. */
export function parityFor(file: string) {
  return function parity(name: string, scenario: Scenario, options: ParityOptions = {}): void {
    const timeout = options.timeout ?? 20_000;
    if (CHILD_IMPL && CHILD_OUT) {
      // Child process: run only the requested test, for one implementation.
      if (name !== CHILD_TEST) return;
      test(
        name,
        async () => {
          const outcome = await runInProcess(CHILD_IMPL, scenario);
          await Bun.write(CHILD_OUT, JSON.stringify(outcome));
        },
        timeout * 2,
      );
      return;
    }
    test.skipIf(options.skip === true)(
      name,
      async () => {
        const run = (impl: Impl) =>
          options.isolate ? runInChild(file, name, impl, timeout) : runInProcess(impl, scenario);
        const official = await run("official");
        // On mismatch the diff shows the whole official outcome, which points at the scenario bug.
        if (options.official && !(options.official in official)) {
          expect(official).toEqual({ [options.official]: expect.anything() } as Outcome);
        }
        const ours = await run("ours");
        expect(ours).toEqual(official);
      },
      options.isolate ? timeout * 2 + 10_000 : timeout,
    );
  };
}
