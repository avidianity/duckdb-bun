// Huge-value parity: every fixed-width type at its extremes, written through a data chunk and
// through the appender's typed methods, and payloads far larger than one vector or one string
// buffer (multi-megabyte strings and blobs, a million-element list, a thousand-digit BIGNUM).
// Large payloads are compared by length and SHA-256, so a mismatch stays readable.
import type { DuckDBAppender, DuckDBConnection, DuckDBType, DuckDBValue } from "@duckdb/node-api";
import { type Api, parityFor, withConnection } from "./harness.ts";

const parity = parityFor(import.meta.path);

/** One column: its SQL type, its node-api type, and the values written to it, NULL last. */
type Column = { name: string; sql: string; type: DuckDBType; values: DuckDBValue[] };

/** The extremes of each fixed-width type, plus zero or a near-zero value and NULL. */
function extremeColumns(api: Api): Column[] {
  const i128 = 2n ** 127n;
  const decimal38 = 10n ** 38n - 1n;
  return [
    { name: "b", sql: "BOOLEAN", type: api.BOOLEAN, values: [true, false, true, null] },
    { name: "i8", sql: "TINYINT", type: api.TINYINT, values: [-128, 127, 0, null] },
    { name: "i16", sql: "SMALLINT", type: api.SMALLINT, values: [-32768, 32767, 0, null] },
    { name: "i32", sql: "INTEGER", type: api.INTEGER, values: [-(2 ** 31), 2 ** 31 - 1, 0, null] },
    { name: "i64", sql: "BIGINT", type: api.BIGINT, values: [-(2n ** 63n), 2n ** 63n - 1n, 0n, null] },
    { name: "i128", sql: "HUGEINT", type: api.HUGEINT, values: [-i128, i128 - 1n, -1n, null] },
    { name: "u8", sql: "UTINYINT", type: api.UTINYINT, values: [0, 255, 1, null] },
    { name: "u16", sql: "USMALLINT", type: api.USMALLINT, values: [0, 65535, 1, null] },
    { name: "u32", sql: "UINTEGER", type: api.UINTEGER, values: [0, 2 ** 32 - 1, 1, null] },
    { name: "u64", sql: "UBIGINT", type: api.UBIGINT, values: [0n, 2n ** 64n - 1n, 1n, null] },
    { name: "u128", sql: "UHUGEINT", type: api.UHUGEINT, values: [0n, 2n ** 128n - 1n, 1n, null] },
    {
      name: "d16",
      sql: "DECIMAL(4, 1)",
      type: api.DECIMAL(4, 1),
      values: [api.decimalValue(-9999n, 4, 1), api.decimalValue(9999n, 4, 1), api.decimalValue(1n, 4, 1), null],
    },
    {
      name: "d32",
      sql: "DECIMAL(9, 4)",
      type: api.DECIMAL(9, 4),
      values: [
        api.decimalValue(-999_999_999n, 9, 4),
        api.decimalValue(999_999_999n, 9, 4),
        api.decimalValue(1n, 9, 4),
        null,
      ],
    },
    {
      name: "d64",
      sql: "DECIMAL(18, 6)",
      type: api.DECIMAL(18, 6),
      values: [
        api.decimalValue(-(10n ** 18n - 1n), 18, 6),
        api.decimalValue(10n ** 18n - 1n, 18, 6),
        api.decimalValue(1n, 18, 6),
        null,
      ],
    },
    {
      name: "d128",
      sql: "DECIMAL(38, 10)",
      type: api.DECIMAL(38, 10),
      values: [
        api.decimalValue(-decimal38, 38, 10),
        api.decimalValue(decimal38, 38, 10),
        api.decimalValue(1n, 38, 10),
        null,
      ],
    },
    {
      name: "f32",
      sql: "FLOAT",
      type: api.FLOAT,
      values: [-3.4028234663852886e38, 3.4028234663852886e38, 1.401298464324817e-45, null],
    },
    {
      name: "f64",
      sql: "DOUBLE",
      type: api.DOUBLE,
      values: [-Number.MAX_VALUE, Number.MAX_VALUE, Number.MIN_VALUE, null],
    },
    {
      name: "dt",
      sql: "DATE",
      type: api.DATE,
      values: [api.DuckDBDateValue.Min, api.DuckDBDateValue.Max, api.DuckDBDateValue.PosInf, null],
    },
    {
      name: "tm",
      sql: "TIME",
      type: api.TIME,
      values: [api.DuckDBTimeValue.Min, api.DuckDBTimeValue.Max, api.timeValue(1n), null],
    },
    {
      name: "tmns",
      sql: "TIME_NS",
      type: api.TIME_NS,
      values: [api.DuckDBTimeNSValue.Min, api.DuckDBTimeNSValue.Max, api.timeNSValue(1n), null],
    },
    {
      name: "tmtz",
      sql: "TIMETZ",
      type: api.TIMETZ,
      values: [api.DuckDBTimeTZValue.Min, api.DuckDBTimeTZValue.Max, api.timeTZValue(0n, 0), null],
    },
    {
      name: "ts",
      sql: "TIMESTAMP",
      type: api.TIMESTAMP,
      values: [api.DuckDBTimestampValue.Min, api.DuckDBTimestampValue.Max, api.DuckDBTimestampValue.NegInf, null],
    },
    {
      name: "tss",
      sql: "TIMESTAMP_S",
      type: api.TIMESTAMP_S,
      values: [
        api.DuckDBTimestampSecondsValue.Min,
        api.DuckDBTimestampSecondsValue.Max,
        api.DuckDBTimestampSecondsValue.PosInf,
        null,
      ],
    },
    {
      name: "tsms",
      sql: "TIMESTAMP_MS",
      type: api.TIMESTAMP_MS,
      values: [
        api.DuckDBTimestampMillisecondsValue.Min,
        api.DuckDBTimestampMillisecondsValue.Max,
        api.DuckDBTimestampMillisecondsValue.PosInf,
        null,
      ],
    },
    {
      name: "tsns",
      sql: "TIMESTAMP_NS",
      type: api.TIMESTAMP_NS,
      values: [
        api.DuckDBTimestampNanosecondsValue.Min,
        api.DuckDBTimestampNanosecondsValue.Max,
        api.DuckDBTimestampNanosecondsValue.PosInf,
        null,
      ],
    },
    {
      name: "tstz",
      sql: "TIMESTAMPTZ",
      type: api.TIMESTAMPTZ,
      values: [api.DuckDBTimestampTZValue.Min, api.DuckDBTimestampTZValue.Max, api.DuckDBTimestampTZValue.PosInf, null],
    },
    {
      name: "tstzns",
      sql: "TIMESTAMPTZ_NS",
      type: api.TIMESTAMPTZ_NS,
      values: [
        api.DuckDBTimestampTZNanosecondsValue.Min,
        api.DuckDBTimestampTZNanosecondsValue.Max,
        api.DuckDBTimestampTZNanosecondsValue.NegInf,
        null,
      ],
    },
    {
      name: "iv",
      sql: "INTERVAL",
      type: api.INTERVAL,
      values: [
        api.intervalValue(-(2 ** 31), -(2 ** 31), -(2n ** 63n)),
        api.intervalValue(2 ** 31 - 1, 2 ** 31 - 1, 2n ** 63n - 1n),
        api.intervalValue(0, 0, 1n),
        null,
      ],
    },
    {
      name: "id",
      sql: "UUID",
      type: api.UUID,
      values: [api.DuckDBUUIDValue.Min, api.DuckDBUUIDValue.Max, api.uuidValue(0n), null],
    },
  ];
}

/** Every row of `t`, as values and as DuckDB's own VARCHAR rendering. */
async function readBack(connection: DuckDBConnection) {
  return {
    rows: (await connection.runAndReadAll("SELECT * FROM t ORDER BY rowid")).getRows(),
    text: (await connection.runAndReadAll("SELECT COLUMNS(*)::VARCHAR FROM t ORDER BY rowid")).getRows(),
  };
}

function createTable(columns: Column[]): string {
  return `CREATE TABLE t (${columns.map((column) => `${column.name} ${column.sql}`).join(", ")})`;
}

parity(
  "extremes of every fixed-width type through a data chunk and appendDataChunk",
  (api) =>
    withConnection(api, async (connection) => {
      const columns = extremeColumns(api);
      await connection.run(createTable(columns));
      const chunk = api.DuckDBDataChunk.create(columns.map((column) => column.type));
      chunk.setColumns(columns.map((column) => column.values));
      const written = { rowCount: chunk.rowCount, columns: chunk.getColumns() };
      const appender = await connection.createAppender("t");
      appender.appendDataChunk(chunk);
      appender.closeSync();
      return { written, ...(await readBack(connection)) };
    }),
  { official: "ok" },
);

parity(
  "extremes of every fixed-width type through the appender's typed methods",
  (api) =>
    withConnection(api, async (connection) => {
      const columns = extremeColumns(api);
      await connection.run(createTable(columns));
      const appender = await connection.createAppender("t");
      // The method for each column, in column order; NULL goes through appendNull.
      const methods: ((appender: DuckDBAppender, value: never) => void)[] = [
        (a, v) => a.appendBoolean(v),
        (a, v) => a.appendTinyInt(v),
        (a, v) => a.appendSmallInt(v),
        (a, v) => a.appendInteger(v),
        (a, v) => a.appendBigInt(v),
        (a, v) => a.appendHugeInt(v),
        (a, v) => a.appendUTinyInt(v),
        (a, v) => a.appendUSmallInt(v),
        (a, v) => a.appendUInteger(v),
        (a, v) => a.appendUBigInt(v),
        (a, v) => a.appendUHugeInt(v),
        (a, v) => a.appendDecimal(v),
        (a, v) => a.appendDecimal(v),
        (a, v) => a.appendDecimal(v),
        (a, v) => a.appendDecimal(v),
        (a, v) => a.appendFloat(v),
        (a, v) => a.appendDouble(v),
        (a, v) => a.appendDate(v),
        (a, v) => a.appendTime(v),
        (a, v) => a.appendValue(v, api.TIME_NS),
        (a, v) => a.appendTimeTZ(v),
        (a, v) => a.appendTimestamp(v),
        (a, v) => a.appendTimestampSeconds(v),
        (a, v) => a.appendTimestampMilliseconds(v),
        (a, v) => a.appendTimestampNanoseconds(v),
        (a, v) => a.appendTimestampTZ(v),
        (a, v) => a.appendTimestampTZNanoseconds(v),
        (a, v) => a.appendInterval(v),
        (a, v) => a.appendUUID(v),
      ];
      if (methods.length !== columns.length) throw new Error("one append method per column");
      const rowCount = columns[0]?.values.length ?? 0;
      for (let row = 0; row < rowCount; row++) {
        columns.forEach((column, index) => {
          const value = column.values[row];
          if (value === null || value === undefined) appender.appendNull();
          else methods[index]?.(appender, value as never);
        });
        appender.endRow();
      }
      appender.closeSync();
      return readBack(connection);
    }),
  { official: "ok" },
);

/** Length and SHA-256 of a large string or byte array, so outcomes stay small. */
function digest(value: unknown): { length: number; sha256: string } | unknown {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) return value;
  return { length: value.length, sha256: new Bun.CryptoHasher("sha256").update(value).digest("hex") };
}

const MiB = 1024 * 1024;

parity(
  "multi-megabyte VARCHAR and BLOB values, bound and selected",
  (api) =>
    withConnection(api, async (connection) => {
      const text = "0123456789abcdef".repeat(MiB); // 16 MiB
      const bytes = new Uint8Array(8 * MiB).map((_, i) => (i * 31) & 0xff);
      const prepared = await connection.prepare("SELECT $1::VARCHAR AS s, $2::BLOB AS b, length($1) AS n");
      prepared.bindVarchar(1, text);
      prepared.bindBlob(2, bytes);
      const bound = (await prepared.runAndReadAll())
        .getRows()[0]
        ?.map((value) => (value instanceof api.DuckDBBlobValue ? digest(value.bytes) : digest(value)));
      const generated = (
        await connection.runAndReadAll(
          `SELECT repeat('xyz', ${4 * MiB}) AS s, repeat('\\xAA\\x00'::BLOB, ${2 * MiB}) AS b, ${MiB} AS n`,
        )
      )
        .getRows()[0]
        ?.map((value) => (value instanceof api.DuckDBBlobValue ? digest(value.bytes) : digest(value)));
      return { bound, generated };
    }),
  { official: "ok", timeout: 60_000 },
);

parity(
  "a million-element LIST and a long ARRAY, read as values and as JSON",
  (api) =>
    withConnection(api, async (connection) => {
      const reader = await connection.runAndReadAll(
        "SELECT list(i) AS l, array_value(1, 2, 3)::INTEGER[3] AS a FROM range(1000000) t(i)",
      );
      const [list] = reader.getRows()[0] ?? [];
      const items = list instanceof api.DuckDBListValue ? list.items : [];
      const json = reader.getRowsJson()[0]?.[0];
      return {
        count: items.length,
        first: items.slice(0, 3),
        last: items.slice(-3),
        jsonCount: Array.isArray(json) ? json.length : json,
        array: reader.getRowsJson()[0]?.[1],
      };
    }),
  { official: "ok", timeout: 60_000 },
);

parity(
  "BIGNUM and BIT values far wider than 128 bits, selected, bound and appended",
  (api) =>
    withConnection(api, async (connection) => {
      const big = 10n ** 1000n - 1n;
      await connection.run("CREATE TABLE t (n BIGNUM, bits BIT)");
      const appender = await connection.createAppender("t");
      // Not 0n: the official binding appends zero as an empty BIGNUM that DuckDB rejects later
      // with a fatal error; ours appends one zero byte on purpose (src/bindings/runtime/convert.ts).
      for (const n of [big, -big, 1n]) {
        appender.appendBigNum(n);
        appender.appendBit(api.bitValue("10".repeat(5000)));
        appender.endRow();
      }
      appender.closeSync();
      const prepared = await connection.prepare("SELECT $1::BIGNUM + 1 AS n");
      prepared.bindBigNum(1, big);
      const rows = (
        await connection.runAndReadAll("SELECT n, bits, n::VARCHAR AS text FROM t ORDER BY rowid")
      ).getRows();
      return {
        appended: rows.map(([n, bits, text]) => [
          n,
          bits instanceof api.DuckDBBitValue ? digest(bits.toString()) : bits,
          digest(text),
        ]),
        bound: (await prepared.runAndReadAll()).getRows(),
        selected: (await connection.runAndReadAll("SELECT ('-' || repeat('9', 2000))::BIGNUM AS n")).getRows(),
      };
    }),
  { official: "ok", timeout: 60_000 },
);
