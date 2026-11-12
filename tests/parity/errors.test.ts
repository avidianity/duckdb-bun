// Error parity: the exact error class and message text for failed queries, closed
// handles, prepare failures, and bind failures.
import type { DuckDBConnection, DuckDBDateValue, DuckDBPreparedStatement } from "@duckdb/node-api";
import { type Api, capture, describeError, parityFor, withConnection } from "./harness.ts";

const parity = parityFor(import.meta.path);

/** Runs `setup` then `sql` with runAndReadAll and returns the rows as JSON. */
function query(sql: string, setup?: string) {
  return (api: Api) =>
    withConnection(api, async (connection) => {
      if (setup) await connection.run(setup);
      return (await connection.runAndReadAll(sql)).getRowsJson();
    });
}

const QUERY_ERRORS: [name: string, sql: string, setup?: string][] = [
  ["syntax error", "SELCT 1"],
  ["syntax error at end of input", "SELECT 1 +"],
  ["missing table (Catalog Error)", "SELECT * FROM does_not_exist"],
  ["missing column (Binder Error)", "SELECT nope FROM range(1)"],
  ["missing function", "SELECT no_such_function(1)"],
  [
    "primary key violation",
    "INSERT INTO t VALUES (1)",
    "CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1)",
  ],
  ["NOT NULL violation", "INSERT INTO t VALUES (NULL)", "CREATE TABLE t (id INTEGER NOT NULL)"],
  ["CHECK violation", "INSERT INTO t VALUES (-1)", "CREATE TABLE t (id INTEGER CHECK (id > 0))"],
  [
    "foreign key violation",
    "INSERT INTO child VALUES (2)",
    "CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (pid INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES (1)",
  ],
  ["conversion error", "SELECT 'x'::INTEGER"],
  ["conversion error inside a table scan", "SELECT v::INTEGER FROM (VALUES ('1'), ('2'), ('x')) t(v)"],
  ["timestamp conversion error", "SELECT 'not a time'::TIMESTAMP"],
  ["integer overflow (Out of Range)", "SELECT 2147483647::INTEGER + 1::INTEGER"],
  ["division by zero with /", "SELECT 1 / 0 AS r"],
  ["integer division by zero with //", "SELECT 1 // 0 AS r"],
  ["modulo by zero", "SELECT 1 % 0 AS r"],
  ["error() function", "SELECT error('boom')"],
  ["COMMIT without a transaction", "COMMIT"],
  ["aborted transaction", "SELECT 1", "BEGIN; CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1), (1)"],
  ["second statement fails", "CREATE TABLE ok_table (i INTEGER); SELECT * FROM does_not_exist"],
  ["empty query", ""],
];

for (const [name, sql, setup] of QUERY_ERRORS) {
  parity(`query error: ${name}`, query(sql, setup));
}

parity(
  "failed setup statement keeps the connection usable",
  (api) =>
    withConnection(api, async (connection) => ({
      failed: await capture(() =>
        connection.run("CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1), (1)"),
      ),
      after: (await connection.runAndReadAll("SELECT count(*) AS n FROM t")).getRowsJson(),
    })),
  { official: "ok" },
);

parity(
  "runtime error during a streamed read",
  (api) =>
    withConnection(api, async (connection) => {
      const reader = await connection.streamAndReadAll(
        "SELECT CASE WHEN i = 50000 THEN error('late failure') ELSE i END AS v FROM range(100000) t(i)",
      );
      return reader.currentRowCount;
    }),
  { official: "error" },
);

parity(
  "runtime error through run() then fetch",
  (api) =>
    withConnection(api, async (connection) => {
      const result = await connection.run("SELECT error('in run')");
      return result.getRowsJson();
    }),
  { official: "error" },
);

parity(
  "runtime error through start()",
  (api) =>
    withConnection(api, async (connection) => {
      const pending = await connection.start("SELECT error('in start')");
      const result = await pending.getResult();
      return result.columnCount;
    }),
  { official: "error" },
);

// A closed or disconnected connection can crash a binding, so each call runs isolated.
const CLOSED_CONNECTION_CALLS: [name: string, call: (connection: DuckDBConnection) => Promise<unknown>][] = [
  ["run", (connection) => connection.run("SELECT 1")],
  ["runAndReadAll", async (connection) => (await connection.runAndReadAll("SELECT 1")).getRowsJson()],
  ["prepare", (connection) => connection.prepare("SELECT 1")],
  ["stream", (connection) => connection.stream("SELECT 1")],
  ["start", (connection) => connection.start("SELECT 1")],
  ["extractStatements", (connection) => connection.extractStatements("SELECT 1")],
  ["createAppender", (connection) => connection.createAppender("t")],
];

for (const [method, call] of CLOSED_CONNECTION_CALLS) {
  for (const how of ["closeSync", "disconnectSync"] as const) {
    parity(
      `${method} on a connection after ${how}`,
      (api) =>
        withConnection(api, async (connection, instance) => {
          await connection.run("CREATE TABLE t (i INTEGER)");
          const closed = await instance.connect();
          closed[how]();
          return {
            call: await capture(() => call(closed)),
            sanity: (await connection.runAndReadAll("SELECT 1 AS ok")).getRowsJson(),
          };
        }),
      { official: "ok", isolate: true },
    );
  }
}

parity(
  "query after the instance is closed",
  async (api) => {
    const instance = await api.DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    instance.closeSync();
    const outcome = await capture(async () => (await connection.runAndReadAll("SELECT 42 AS answer")).getRowsJson());
    connection.closeSync();
    return outcome;
  },
  { official: "ok", isolate: true },
);

parity(
  "connect after the instance is closed",
  async (api) => {
    const instance = await api.DuckDBInstance.create(":memory:");
    instance.closeSync();
    return capture(async () => {
      const connection = await instance.connect();
      return (await connection.runAndReadAll("SELECT 42 AS answer")).getRowsJson();
    });
  },
  { official: "ok", isolate: true },
);

const PREPARE_ERRORS: [name: string, sql: string][] = [
  ["syntax error", "SELCT ?"],
  ["missing table", "SELECT * FROM does_not_exist WHERE id = ?"],
  ["missing column", "SELECT nope FROM range(3) WHERE range = ?"],
  ["two statements", "SELECT 1; SELECT 2"],
  ["empty statement", ""],
];

for (const [name, sql] of PREPARE_ERRORS) {
  parity(`prepare error: ${name}`, (api) =>
    withConnection(api, async (connection) => {
      const prepared = await connection.prepare(sql);
      return { parameterCount: prepared.parameterCount };
    }),
  );
}

/** Prepares `sql`, applies `bind`, and returns each step's outcome. */
function bindScenario(sql: string, bind: (prepared: DuckDBPreparedStatement, api: Api) => unknown) {
  return (api: Api) =>
    withConnection(api, async (connection) => {
      const prepared = await connection.prepare(sql);
      const bound = await capture(() => bind(prepared, api));
      const ran = await capture(async () => (await prepared.runAndReadAll()).getRowsJson());
      return { bound, ran };
    });
}

parity(
  "bind error: index past the last parameter",
  bindScenario("SELECT $1::INTEGER AS v", (prepared) => prepared.bindInteger(2, 1)),
  { official: "ok" },
);

parity(
  "bind error: index zero",
  bindScenario("SELECT $1::INTEGER AS v", (prepared) => prepared.bindInteger(0, 1)),
  { official: "ok" },
);

parity(
  "bind error: varchar into an integer parameter",
  bindScenario("SELECT $1::INTEGER + 1 AS v", (prepared) => prepared.bindVarchar(1, "abc")),
  { official: "ok" },
);

parity(
  "bind error: integer into a date parameter",
  bindScenario("SELECT $1::DATE AS v", (prepared) => prepared.bindInteger(1, 5)),
  { official: "ok" },
);

parity(
  "bind error: list into an integer parameter",
  bindScenario("SELECT $1::INTEGER AS v", (prepared, api) => prepared.bindList(1, api.listValue([1, 2]))),
  { official: "ok" },
);

parity(
  "bind error: unknown parameter name",
  bindScenario("SELECT $a::INTEGER AS v", (prepared) => prepared.bind({ nope: 1 })),
  { official: "ok" },
);

parity(
  "bind error: parameterIndex of an unknown name",
  bindScenario("SELECT $a::INTEGER AS v", (prepared) => prepared.parameterIndex("nope")),
  { official: "ok" },
);

parity(
  "bind error: parameterName out of range",
  bindScenario("SELECT $a::INTEGER AS v", (prepared) => prepared.parameterName(5)),
  { official: "ok" },
);

parity(
  "bind error: too many positional values",
  bindScenario("SELECT ?::INTEGER AS v", (prepared) => prepared.bind([1, 2])),
  { official: "ok" },
);

parity(
  "bind error: run without binding",
  bindScenario("SELECT ?::INTEGER AS v", () => undefined),
  { official: "ok" },
);

parity(
  "bind error: run after clearBindings",
  bindScenario("SELECT ?::INTEGER AS v", (prepared) => {
    prepared.bindInteger(1, 7);
    prepared.clearBindings();
  }),
  { official: "ok" },
);

/** The outcome of a call made where a scenario cannot await, such as inside a function callback. */
function captureSync(fn: () => unknown): { ok: unknown } | { error: { class: string; message: string } } {
  try {
    return { ok: fn() };
  } catch (err) {
    return { error: describeError(err) };
  }
}

// node-addon-api raises "A number was expected", and the string, boolean, and
// object expectations, as a TypeError. N-API reads the fields of a primitive's
// wrapper object, so a number given for a date fails on its missing field.
parity("bind error: arguments of the wrong JavaScript type", (api) =>
  withConnection(api, async (connection) => {
    const prepared = await connection.prepare("SELECT $1::INTEGER, $2::VARCHAR, $3::BOOLEAN, $4::DATE");
    return {
      integer: captureSync(() => prepared.bindInteger(1, "1" as unknown as number)),
      varchar: captureSync(() => prepared.bindVarchar(2, 1 as unknown as string)),
      boolean: captureSync(() => prepared.bindBoolean(3, 1 as unknown as boolean)),
      date: captureSync(() => prepared.bindDate(4, 5 as unknown as DuckDBDateValue)),
    };
  }),
);

// The official binding keeps extra info, bind data, init data, and scalar
// function state with napi_create_reference, which refuses null and the number,
// string, boolean, and bigint primitives with "Invalid argument".
const USER_DATA: [name: string, data: unknown][] = [
  ["number", 1],
  ["string", "s"],
  ["boolean", true],
  ["bigint", 1n],
  ["null", null],
  ["undefined", undefined],
  ["symbol", Symbol("s")],
  ["object", {}],
];

parity("function user data of every JavaScript type", (api) =>
  withConnection(api, async (connection) => {
    const outcomes: Record<string, Record<string, unknown>> = {};
    for (const [name, value] of USER_DATA) {
      const data = value as object;
      const steps: Record<string, unknown> = {};
      const scalar = api.DuckDBScalarFunction.create({
        name: `scalar_${name}`,
        returnType: api.INTEGER,
        bindFunction: (info) => {
          steps.scalarBindData = captureSync(() => info.setBindData(data));
        },
        initFunction: (info) => {
          steps.scalarState = captureSync(() => info.setState(data));
        },
        mainFunction: () => {},
      });
      steps.scalarExtraInfo = captureSync(() => scalar.setExtraInfo(data));
      connection.registerScalarFunction(scalar);
      steps.scalarRan = await capture(async () =>
        (await connection.runAndReadAll(`SELECT scalar_${name}()`)).getRowsJson(),
      );
      const table = api.DuckDBTableFunction.create({
        name: `table_${name}`,
        bindFunction: (info) => {
          info.addResultColumn("c", api.INTEGER);
          steps.tableBindData = captureSync(() => info.setBindData(data));
        },
        initFunction: (info) => {
          steps.tableInitData = captureSync(() => info.setInitData(data));
        },
        mainFunction: (_info, output) => {
          output.rowCount = 0;
        },
      });
      steps.tableExtraInfo = captureSync(() => table.setExtraInfo(data));
      connection.registerTableFunction(table);
      steps.tableRan = await capture(async () =>
        (await connection.runAndReadAll(`SELECT * FROM table_${name}()`)).getRowsJson(),
      );
      outcomes[name] = steps;
    }
    return outcomes;
  }),
);
