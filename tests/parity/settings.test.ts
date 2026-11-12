// Settings parity: SET, RESET, current_setting() and duckdb_settings() rows, and
// options passed to DuckDBInstance.create(path, options).
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { capture, parityFor, withConnection } from "./harness.ts";

const parity = parityFor(import.meta.path);

const SETTINGS = ["threads", "memory_limit", "TimeZone", "default_order"];

async function settingRows(connection: DuckDBConnection) {
  const reader = await connection.runAndReadAll(
    `SELECT name, value, description, input_type, scope FROM duckdb_settings() WHERE name IN (${SETTINGS.map((s) => `'${s}'`).join(", ")}) ORDER BY name`,
  );
  return reader.getRowObjectsJson();
}

async function current(connection: DuckDBConnection, name: string) {
  return (await connection.runAndReadAll(`SELECT current_setting('${name}') AS v`)).getRowsJson()[0][0];
}

const SET_CASES: [name: string, value: string][] = [
  ["threads", "3"],
  ["memory_limit", "'1GB'"],
  ["TimeZone", "'America/New_York'"],
  ["default_order", "'DESC'"],
];

for (const [name, value] of SET_CASES) {
  parity(
    `SET, current_setting and RESET ${name}`,
    (api) =>
      withConnection(api, async (connection) => {
        const before = await current(connection, name);
        await connection.run(`SET ${name} = ${value}`);
        const after = await current(connection, name);
        const rows = await settingRows(connection);
        await connection.run(`RESET ${name}`);
        return { before, after, rows, reset: await current(connection, name) };
      }),
    { official: "ok" },
  );
}

parity(
  "duckdb_settings() rows with defaults",
  (api) => withConnection(api, async (connection) => settingRows(connection)),
  { official: "ok" },
);

parity(
  "SET effects on query results",
  (api) =>
    withConnection(api, async (connection) => {
      await connection.run("SET default_order = 'DESC'; SET TimeZone = 'Asia/Tokyo'");
      return (
        await connection.runAndReadAll(
          "SELECT i, TIMESTAMPTZ '2026-01-01 00:00:00+00' AS ts, strftime(TIMESTAMPTZ '2026-01-01 00:00:00+00', '%Y-%m-%d %H:%M %Z') AS s FROM range(3) t(i) ORDER BY i",
        )
      ).getRowsJson();
    }),
  { official: "ok" },
);

parity(
  "invalid SET values",
  (api) =>
    withConnection(api, async (connection) => ({
      threads: await capture(() => connection.run("SET threads = -1")),
      memory: await capture(() => connection.run("SET memory_limit = 'lots'")),
      timeZone: await capture(() => connection.run("SET TimeZone = 'Mars/Olympus_Mons'")),
      order: await capture(() => connection.run("SET default_order = 'sideways'")),
      unknown: await capture(() => connection.run("SET no_such_setting = 1")),
      currentUnknown: await capture(() => connection.run("SELECT current_setting('no_such_setting')")),
    })),
  { official: "ok" },
);

parity(
  "instance options for an in-memory database",
  async (api) => {
    const options = { threads: "2", memory_limit: "512MB", TimeZone: "Asia/Manila", default_order: "DESC" };
    return withConnection(
      api,
      async (connection) => ({
        current: await Promise.all(SETTINGS.map((name) => current(connection, name))),
        rows: await settingRows(connection),
      }),
      ":memory:",
      options,
    );
  },
  { official: "ok" },
);

parity(
  "instance options for a file database, then reopened read-only",
  async (api, { tmp }) => {
    const path = join(tmp, "settings.duckdb");
    const written = await withConnection(
      api,
      async (connection) => {
        await connection.run("CREATE TABLE t AS SELECT 1 AS i");
        return { threads: await current(connection, "threads"), timeZone: await current(connection, "TimeZone") };
      },
      path,
      { threads: "1", TimeZone: "UTC" },
    );
    const readOnly = await withConnection(
      api,
      async (connection) => ({
        accessMode: await current(connection, "access_mode"),
        rows: (await connection.runAndReadAll("SELECT * FROM t")).getRowsJson(),
        write: await capture(() => connection.run("INSERT INTO t VALUES (2)")),
        databases: (
          await connection.runAndReadAll(
            "SELECT database_name, path, readonly FROM duckdb_databases() WHERE NOT internal",
          )
        ).getRowsJson(),
      }),
      path,
      { access_mode: "READ_ONLY" },
    );
    return { written, readOnly };
  },
  { official: "ok" },
);

parity("instance option with an unknown name", (api) =>
  api.DuckDBInstance.create(":memory:", { no_such_option: "1" }).then((instance) => instance.closeSync()),
);

parity("instance option with an invalid value", (api) =>
  api.DuckDBInstance.create(":memory:", { threads: "many" }).then((instance) => instance.closeSync()),
);

parity("read-only instance on a missing file", (api, { tmp }) =>
  api.DuckDBInstance.create(join(tmp, "missing.duckdb"), { access_mode: "READ_ONLY" }).then((instance) =>
    instance.closeSync(),
  ),
);
