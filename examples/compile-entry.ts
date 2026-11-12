// Minimal entrypoint used to prove `bun build --compile` yields a standalone
// binary with libduckdb and the shim embedded. Prints a JSON line the compile test asserts on.
import { DuckDBInstance, diagnostics, version } from "../src/neo.ts";

const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();
const scalar = await connection.runAndReadAll("SELECT 'ok' AS v, 42::BIGINT AS n");
const multi = await connection.runAndReadAll("SELECT COUNT(*) AS c FROM range(3000)");
connection.closeSync();
instance.closeSync();

const [row] = scalar.getRowObjectsJson();
const { paths, crashHandler } = diagnostics();
console.log(
  JSON.stringify({
    version: version(),
    v: row.v,
    n: row.n,
    count: multi.getRowsJson()[0][0],
    crashHandler,
    paths: [paths.libduckdb, paths.shim],
  }),
);
