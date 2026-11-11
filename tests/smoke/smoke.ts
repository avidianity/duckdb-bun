// Smoke test for the packed packages, run by the docker-smoke CI job inside the oven/bun image that
// production uses. It runs in a fresh project that installed the main tarball and the linux-x64 tarball,
// so it imports the package by name, the way a user does.
//
//   bun smoke.ts           queries, extensions, diagnostics, then the crash report in a child process
//   bun smoke.ts --crash   the child: crashes on purpose through the package's crash test hook
//
// It needs network access for INSTALL; it is not part of `bun test`.
import { DuckDBInstance, diagnostics } from "@avidian/duckdb-bun";

const CRASH_FLAG = "--crash";
const FATAL_SIGNAL_LINE = "[duckdb-bun] fatal signal";

function fail(message: string): never {
  throw new Error(`smoke: ${message}`);
}

function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2);
}

async function crashChild(): Promise<void> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run("SELECT 1");
  // TODO(diagnostics): the crash test hook's name is not final; this is the only placeholder in this file.
  diagnostics().__crashForTest(1);
  fail("the crash test hook returned instead of crashing the process");
}

async function main(): Promise<void> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  const reader = await connection.runAndReadAll("SELECT 42 AS answer, version() AS version");
  const [row] = reader.getRowObjectsJson();
  if (row?.answer !== 42) fail(`SELECT 42 returned ${toJson(row)}`);
  console.log(`query ok: DuckDB ${row.version}`);

  for (const sql of ["INSTALL azure", "LOAD azure", "INSTALL icu", "LOAD icu"]) {
    await connection.run(sql);
    console.log(`${sql}: ok`);
  }
  const loaded = await connection.runAndReadAll(
    "SELECT extension_name FROM duckdb_extensions() WHERE loaded AND extension_name IN ('azure', 'icu') ORDER BY 1",
  );
  const names = loaded.getRowObjectsJson().map((item) => item.extension_name);
  if (names.join(",") !== "azure,icu") fail(`loaded extensions are ${toJson(names)}, expected azure and icu`);

  console.log(`diagnostics(): ${toJson(diagnostics())}`);

  connection.closeSync();
  instance.closeSync();

  const child = Bun.spawn([process.execPath, import.meta.path, CRASH_FLAG], { stdout: "inherit", stderr: "pipe" });
  const [stderr] = await Promise.all([child.stderr.text(), child.exited]);
  console.log(`crash child stderr:\n${stderr}`);
  if (child.exitCode === 0) fail("the crash child exited with status 0");
  if (!stderr.includes(FATAL_SIGNAL_LINE)) fail(`the crash child's stderr has no "${FATAL_SIGNAL_LINE}" line`);
  console.log(`crash report ok (exit code ${child.exitCode}, signal ${child.signalCode})`);
}

if (Bun.argv.includes(CRASH_FLAG)) await crashChild();
else await main();
