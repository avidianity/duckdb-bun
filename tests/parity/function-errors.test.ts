// Error parity for JavaScript functions registered with DuckDB: the query error text when a
// scalar or table function's bind, init or main callback throws or calls setError, and the
// errors of starting a pending result that cannot run. Each scenario also runs a plain query
// afterwards, to show the connection survives the failed one.
import type { DuckDBConnection, DuckDBScalarMainFunction, DuckDBTableFunction } from "@duckdb/node-api";
import { type Api, capture, parityFor, withConnection } from "./harness.ts";

const parity = parityFor(import.meta.path);

type Stage = "bind" | "init" | "main";
type Failure = "throw Error" | "throw string" | "setError";

/** Fails as `failure` says: an Error, a thrown string, or the stage's own `setError`. */
function fail(failure: Failure, stage: string, info: { setError(message: string): void }): void {
  if (failure === "throw Error") throw new Error(`${stage} failed with an Error`);
  if (failure === "throw string") throw `${stage} failed with a string`;
  info.setError(`${stage} failed through setError`);
}

/** Runs `sql`, then a plain query on the same connection. */
async function runThenRecover(connection: DuckDBConnection, sql: string) {
  return {
    failed: await capture(async () => (await connection.runAndReadAll(sql)).getRowsJson()),
    after: (await connection.runAndReadAll("SELECT 42 AS answer")).getRowsJson(),
  };
}

const STAGES: Stage[] = ["bind", "init", "main"];
const FAILURES: Failure[] = ["throw Error", "throw string", "setError"];

function scalarFunction(api: Api, failAt: Stage, failure: Failure) {
  const main: DuckDBScalarMainFunction = (info, input, output) => {
    if (failAt === "main") fail(failure, "scalar main", info);
    for (let row = 0; row < input.rowCount; row++)
      output.setItem(row, Number(input.getColumnVector(0).getItem(row)) * 2);
    output.flush();
  };
  return api.DuckDBScalarFunction.create({
    name: "doubled",
    returnType: api.INTEGER,
    parameterTypes: [api.INTEGER],
    mainFunction: main,
    bindFunction: failAt === "bind" ? (info) => fail(failure, "scalar bind", info) : undefined,
    initFunction: failAt === "init" ? (info) => fail(failure, "scalar init", info) : undefined,
  });
}

for (const stage of STAGES) {
  for (const failure of FAILURES) {
    parity(
      `scalar function ${stage} fails: ${failure}`,
      (api) =>
        withConnection(api, async (connection) => {
          connection.registerScalarFunction(scalarFunction(api, stage, failure));
          return runThenRecover(connection, "SELECT doubled(i::INTEGER) AS d FROM range(3) t(i)");
        }),
      { official: "ok" },
    );
  }
}

function tableFunction(api: Api, failAt: Stage, failure: Failure): DuckDBTableFunction {
  let emitted = false;
  return api.DuckDBTableFunction.create({
    name: "one_row",
    bindFunction: (info) => {
      if (failAt === "bind") return fail(failure, "table bind", info);
      info.addResultColumn("n", api.INTEGER);
    },
    initFunction: (info) => {
      if (failAt === "init") fail(failure, "table init", info);
    },
    mainFunction: (info, output) => {
      if (failAt === "main") return fail(failure, "table main", info);
      output.rowCount = emitted ? 0 : 1;
      if (!emitted) output.setColumnValues(0, [7]);
      emitted = true;
    },
  });
}

for (const stage of STAGES) {
  for (const failure of FAILURES) {
    parity(
      `table function ${stage} fails: ${failure}`,
      (api) =>
        withConnection(api, async (connection) => {
          connection.registerTableFunction(tableFunction(api, stage, failure));
          return runThenRecover(connection, "SELECT * FROM one_row()");
        }),
      { official: "ok" },
    );
  }
}

parity(
  "a scalar function registered twice under one name",
  (api) =>
    withConnection(api, async (connection) => {
      connection.registerScalarFunction(scalarFunction(api, "main", "setError"));
      return {
        second: await capture(() => connection.registerScalarFunction(scalarFunction(api, "main", "setError"))),
        after: (await connection.runAndReadAll("SELECT 42 AS answer")).getRowsJson(),
      };
    }),
  { official: "ok" },
);

parity(
  "start() and startStream() of a prepared statement with an unbound parameter",
  (api) =>
    withConnection(api, async (connection) => {
      const prepared = await connection.prepare("SELECT $1::INTEGER + 1 AS n");
      return {
        start: await capture(() => prepared.start()),
        startStream: await capture(() => prepared.startStream()),
        run: await capture(() => prepared.run()),
        after: (await connection.runAndReadAll("SELECT 42 AS answer")).getRowsJson(),
      };
    }),
  { official: "ok" },
);
