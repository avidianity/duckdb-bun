// Appender parity: append rows of mixed types, flush, close, and read them back,
// plus the appender's metadata and its errors.
import type { DuckDBAppender, DuckDBConnection } from "@duckdb/node-api";
import { type Api, capture, parityFor, withConnection } from "./harness.ts";

const parity = parityFor(import.meta.path);

const TABLE = `
  CREATE TABLE events (
    id INTEGER, big BIGINT, name VARCHAR, amount DECIMAL(18,3), ok BOOLEAN, score DOUBLE,
    day DATE, happened_at TIMESTAMPTZ, ts TIMESTAMP, ref UUID, payload BLOB, tags VARCHAR[],
    meta STRUCT(k VARCHAR, v INTEGER), note VARCHAR DEFAULT 'none'
  )`;

async function readBack(connection: DuckDBConnection) {
  const reader = await connection.runAndReadAll("SELECT * FROM events ORDER BY id");
  return { types: reader.columnTypes().map(String), rows: reader.getRows(), json: reader.getRowObjectsJson() };
}

function appendRow(appender: DuckDBAppender, api: Api, id: number) {
  appender.appendInteger(id);
  appender.appendBigInt(BigInt(id) * 10_000_000_000n);
  appender.appendVarchar(`name ${id} ✓`);
  appender.appendDecimal(api.decimalValue(BigInt(id * 12_345), 18, 3));
  appender.appendBoolean(id % 2 === 0);
  appender.appendDouble(id / 3);
  appender.appendDate(api.dateValue(20_000 + id));
  appender.appendTimestampTZ(api.timestampTZValue(1_752_327_906_123_456n + BigInt(id)));
  appender.appendTimestamp(api.timestampValue(1_752_327_906_000_000n));
  appender.appendUUID(api.uuidValue(BigInt(id) << 64n));
  appender.appendBlob(new Uint8Array([id, 0, 255]));
  appender.appendList(api.listValue([`t${id}`, null]));
  appender.appendStruct(api.structValue({ k: `k${id}`, v: id }));
  appender.appendDefault();
  appender.endRow();
}

parity(
  "append mixed types, flush, close, read back",
  (api) =>
    withConnection(api, async (connection) => {
      await connection.run(TABLE);
      const appender = await connection.createAppender("events");
      const metadata = {
        columnCount: appender.columnCount,
        columnTypes: Array.from({ length: appender.columnCount }, (_, i) => String(appender.columnType(i))),
      };
      for (let id = 1; id <= 3; id++) appendRow(appender, api, id);
      appender.flushSync();
      const afterFlush = (await connection.runAndReadAll("SELECT count(*) AS n FROM events")).getRowsJson();
      appendRow(appender, api, 4);
      appender.closeSync();
      return { metadata, afterFlush, data: await readBack(connection) };
    }),
  { official: "ok" },
);

parity(
  "append nulls and values with inferred and explicit types",
  (api) =>
    withConnection(api, async (connection) => {
      await connection.run(TABLE);
      const appender = await connection.createAppender("events");
      appender.appendValue(1);
      for (let i = 1; i < 13; i++) appender.appendNull();
      appender.appendVarchar("explicit");
      appender.endRow();
      appender.appendValue(2, api.INTEGER);
      appender.appendValue(5n);
      appender.appendValue("inferred");
      appender.appendValue(api.decimalValue(1n, 18, 3));
      appender.appendValue(true);
      appender.appendValue(1.5);
      appender.appendValue(api.dateValue(0));
      appender.appendValue(api.timestampTZValue(0n));
      appender.appendValue(api.timestampValue(0n));
      appender.appendValue(api.uuidValue(1n));
      appender.appendValue(api.blobValue("x"));
      appender.appendValue(api.listValue(["a"]), api.LIST(api.VARCHAR));
      appender.appendValue(api.structValue({ k: "k", v: 1 }), api.STRUCT({ k: api.VARCHAR, v: api.INTEGER }));
      appender.appendNull();
      appender.endRow();
      appender.closeSync();
      return readBack(connection);
    }),
  { official: "ok" },
);

parity(
  "appender into a schema-qualified table, many rows",
  (api) =>
    withConnection(api, async (connection) => {
      await connection.run("CREATE SCHEMA s; CREATE TABLE s.t (i INTEGER, v VARCHAR)");
      const appender = await connection.createAppender("t", "s");
      for (let i = 0; i < 5000; i++) {
        appender.appendInteger(i);
        appender.appendVarchar(`v${i}`);
        appender.endRow();
      }
      appender.closeSync();
      return (await connection.runAndReadAll("SELECT count(*), sum(i), min(v), max(v) FROM s.t")).getRowsJson();
    }),
  { official: "ok" },
);

/** Runs `step` against a fresh appender on a two-column table and records its outcome and the table afterwards. */
function appenderError(step: (connection: DuckDBConnection, api: Api) => Promise<unknown>) {
  return (api: Api) =>
    withConnection(api, async (connection) => {
      await connection.run("CREATE TABLE t (i INTEGER NOT NULL, d DATE)");
      const outcome = await capture(() => step(connection, api));
      return { outcome, rows: (await connection.runAndReadAll("SELECT * FROM t ORDER BY i")).getRowsJson() };
    });
}

parity(
  "appender error: missing table",
  appenderError((connection) => connection.createAppender("missing")),
  { official: "ok" },
);

parity(
  "appender error: endRow with too few columns",
  appenderError(async (connection) => {
    const appender = await connection.createAppender("t");
    appender.appendInteger(1);
    appender.endRow();
  }),
  { official: "ok" },
);

parity(
  "appender error: too many columns",
  appenderError(async (connection) => {
    const appender = await connection.createAppender("t");
    appender.appendInteger(1);
    appender.appendNull();
    appender.appendInteger(2);
  }),
  { official: "ok" },
);

parity(
  "appender error: varchar into an integer column",
  appenderError(async (connection) => {
    const appender = await connection.createAppender("t");
    appender.appendVarchar("not a number");
    appender.appendNull();
    appender.endRow();
    appender.closeSync();
  }),
  { official: "ok" },
);

parity(
  "appender error: NULL into a NOT NULL column surfaces on flush",
  appenderError(async (connection) => {
    const appender = await connection.createAppender("t");
    appender.appendNull();
    appender.appendNull();
    appender.endRow();
    appender.flushSync();
  }),
  { official: "ok" },
);

parity(
  "appender error: append after close",
  appenderError(async (connection, api) => {
    const appender = await connection.createAppender("t");
    appender.appendInteger(1);
    appender.appendDate(api.dateValue(1));
    appender.endRow();
    appender.closeSync();
    appender.appendInteger(2);
  }),
  { official: "ok", isolate: true },
);
