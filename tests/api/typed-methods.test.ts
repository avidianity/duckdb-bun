// One call to every typed append, bind and metadata method of the API layer, with the value read back.
//
// The forked suites reach most of these only through the parity suite, which runs only while an @duckdb/node-api
// built on the pinned DuckDB exists (tests/reference.ts). This file keeps them tested, and covered, without one.
import { describe, expect, test } from "bun:test";
import {
  bitValue,
  blobValue,
  DuckDBInstance,
  DuckDBTableFunction,
  DuckDBTimestampMillisecondsValue,
  DuckDBTimestampNanosecondsValue,
  DuckDBTypeId,
  dateValue,
  decimalValue,
  INTEGER,
  intervalValue,
  listValue,
  structValue,
  timestampSecondsValue,
  timestampTZValue,
  timestampValue,
  timeTZValue,
  timeValue,
  uuidValue,
  VARCHAR,
} from "../../src/api";

async function withConnection(run: (connection: Awaited<ReturnType<DuckDBInstance["connect"]>>) => Promise<void>) {
  const instance = await DuckDBInstance.create(":memory:", { TimeZone: "UTC" });
  const connection = await instance.connect();
  try {
    await run(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** Column, SQL type, and the value it reads back as. */
const COLUMNS = [
  ["b", "BOOLEAN", true],
  ["ti", "TINYINT", -128],
  ["si", "SMALLINT", -32768],
  ["bi", "BIGINT", -(2n ** 63n)],
  ["hi", "HUGEINT", -(2n ** 127n)],
  ["uti", "UTINYINT", 255],
  ["usi", "USMALLINT", 65535],
  ["ubi", "UBIGINT", 2n ** 64n - 1n],
  ["uhi", "UHUGEINT", 2n ** 128n - 1n],
  ["dec", "DECIMAL(9,2)", decimalValue(12345, 9, 2)],
  ["f", "FLOAT", 1.5],
  ["d", "DOUBLE", -2.25],
  ["day", "DATE", dateValue(19_000)],
  ["t", "TIME", timeValue(45_296_000_001n)],
  ["ttz", "TIMETZ", timeTZValue(45_296_000_001n, 3600)],
  ["ts", "TIMESTAMP", timestampValue(1_752_327_906_123_456n)],
  ["tstz", "TIMESTAMPTZ", timestampTZValue(1_752_327_906_123_456n)],
  ["tss", "TIMESTAMP_S", timestampSecondsValue(1_752_327_906n)],
  ["tsms", "TIMESTAMP_MS", new DuckDBTimestampMillisecondsValue(1_752_327_906_123n)],
  ["tsns", "TIMESTAMP_NS", new DuckDBTimestampNanosecondsValue(1_752_327_906_123_456_789n)],
  ["iv", "INTERVAL", intervalValue(14, 3, 4_000_000n)],
  ["v", "VARCHAR", "naïve ✓"],
  ["bl", "BLOB", blobValue(new Uint8Array([0, 1, 255]))],
  ["l", "INTEGER[]", listValue([1, null, 3])],
  ["s", "STRUCT(k VARCHAR, n INTEGER)", structValue({ k: "key", n: 7 })],
  ["u", "UUID", uuidValue(0x0123_4567_89ab_cdef_0123_4567_89ab_cdefn)],
  ["bit", "BIT", bitValue("10110")],
  ["bn", "BIGNUM", -(10n ** 40n)],
] as const;

describe("typed appender methods", () => {
  test("append one value of every type, a default, and read them back", async () => {
    await withConnection(async (connection) => {
      const columns = COLUMNS.map(([name, type]) => `${name} ${type}`).join(", ");
      await connection.run(`CREATE TABLE t (${columns}, note VARCHAR DEFAULT 'none')`);
      const appender = await connection.createAppender("t");
      const value = (name: string) => COLUMNS.find(([column]) => column === name)?.[2];
      appender.appendBoolean(true);
      appender.appendTinyInt(-128);
      appender.appendSmallInt(-32768);
      appender.appendBigInt(-(2n ** 63n));
      appender.appendHugeInt(-(2n ** 127n));
      appender.appendUTinyInt(255);
      appender.appendUSmallInt(65535);
      appender.appendUBigInt(2n ** 64n - 1n);
      appender.appendUHugeInt(2n ** 128n - 1n);
      appender.appendDecimal(decimalValue(12345, 9, 2));
      appender.appendFloat(1.5);
      appender.appendDouble(-2.25);
      appender.appendDate(value("day") as ReturnType<typeof dateValue>);
      appender.appendTime(value("t") as ReturnType<typeof timeValue>);
      appender.appendTimeTZ(value("ttz") as ReturnType<typeof timeTZValue>);
      appender.appendTimestamp(value("ts") as ReturnType<typeof timestampValue>);
      appender.appendTimestampTZ(value("tstz") as ReturnType<typeof timestampTZValue>);
      appender.appendTimestampSeconds(value("tss") as ReturnType<typeof timestampSecondsValue>);
      appender.appendTimestampMilliseconds(value("tsms") as DuckDBTimestampMillisecondsValue);
      appender.appendTimestampNanoseconds(value("tsns") as DuckDBTimestampNanosecondsValue);
      appender.appendInterval(value("iv") as ReturnType<typeof intervalValue>);
      appender.appendVarchar("naïve ✓");
      appender.appendBlob(new Uint8Array([0, 1, 255]));
      appender.appendList([1, null, 3]);
      appender.appendStruct({ k: "key", n: 7 });
      appender.appendUUID(value("u") as ReturnType<typeof uuidValue>);
      appender.appendBit(value("bit") as ReturnType<typeof bitValue>);
      appender.appendBigNum(-(10n ** 40n));
      appender.appendDefault();
      appender.endRow();
      appender.closeSync();

      const reader = await connection.runAndReadAll("SELECT * FROM t");
      expect(reader.getRows()).toEqual([[...COLUMNS.map(([, , expected]) => expected), "none"]]);
    });
  });
});

describe("typed bind methods", () => {
  test("bind one value of every type and read it back", async () => {
    await withConnection(async (connection) => {
      const casts = COLUMNS.filter(([name]) => !["bit", "bn", "l", "s", "u"].includes(name));
      const prepared = await connection.prepare(
        `SELECT ${casts.map(([name, type], i) => `$${i + 1}::${type} AS ${name}`).join(", ")}`,
      );
      const value = (name: string) => COLUMNS.find(([column]) => column === name)?.[2];
      let index = 0;
      const next = () => ++index;
      prepared.bindBoolean(next(), true);
      prepared.bindTinyInt(next(), -128);
      prepared.bindSmallInt(next(), -32768);
      prepared.bindBigInt(next(), -(2n ** 63n));
      prepared.bindHugeInt(next(), -(2n ** 127n));
      prepared.bindUTinyInt(next(), 255);
      prepared.bindUSmallInt(next(), 65535);
      prepared.bindUBigInt(next(), 2n ** 64n - 1n);
      prepared.bindUHugeInt(next(), 2n ** 128n - 1n);
      prepared.bindDecimal(next(), decimalValue(12345, 9, 2));
      prepared.bindFloat(next(), 1.5);
      prepared.bindDouble(next(), -2.25);
      prepared.bindDate(next(), value("day") as ReturnType<typeof dateValue>);
      prepared.bindTime(next(), value("t") as ReturnType<typeof timeValue>);
      prepared.bindTimeTZ(next(), value("ttz") as ReturnType<typeof timeTZValue>);
      prepared.bindTimestamp(next(), value("ts") as ReturnType<typeof timestampValue>);
      prepared.bindTimestampTZ(next(), value("tstz") as ReturnType<typeof timestampTZValue>);
      prepared.bindTimestampSeconds(next(), value("tss") as ReturnType<typeof timestampSecondsValue>);
      prepared.bindTimestampMilliseconds(next(), value("tsms") as DuckDBTimestampMillisecondsValue);
      prepared.bindTimestampNanoseconds(next(), value("tsns") as DuckDBTimestampNanosecondsValue);
      prepared.bindInterval(next(), value("iv") as ReturnType<typeof intervalValue>);
      prepared.bindVarchar(next(), "naïve ✓");
      prepared.bindBlob(next(), new Uint8Array([0, 1, 255]));
      expect(index).toBe(casts.length);

      const reader = await prepared.runAndReadAll();
      expect(reader.getRows()).toEqual([casts.map(([, , expected]) => expected)]);
      expect(reader.columnTypeId(0)).toBe(DuckDBTypeId.BOOLEAN);
      expect(reader.columnTypeId(casts.length - 1)).toBe(DuckDBTypeId.BLOB);
      expect(reader.columnTypesJson()).toEqual(
        expect.arrayContaining([{ typeId: DuckDBTypeId.BOOLEAN }, { typeId: DuckDBTypeId.TINYINT }]),
      );
    });
  });

  test("clearBindings drops every bound value", async () => {
    await withConnection(async (connection) => {
      const prepared = await connection.prepare("SELECT $1::INTEGER AS a, $2::VARCHAR AS b");
      prepared.bindInteger(1, 1);
      prepared.bindVarchar(2, "x");
      prepared.clearBindings();
      await expect(prepared.run()).rejects.toThrow();
      prepared.bindValue(1, 2, INTEGER);
      prepared.bindValue(2, "y", VARCHAR);
      expect((await prepared.runAndReadAll()).getRows()).toEqual([[2, "y"]]);
    });
  });
});

describe("pending results and table function errors", () => {
  test("a pending result reads all rows", async () => {
    await withConnection(async (connection) => {
      const prepared = await connection.prepare("SELECT * FROM range(3000) r(i)");
      const reader = await prepared.start().readAll();
      expect(reader.currentRowCount).toBe(3000);
      expect(reader.done).toBe(true);
    });
  });

  test("setError in bind and init fails the query with that message", async () => {
    await withConnection(async (connection) => {
      const failing = (stage: "bind" | "init") =>
        DuckDBTableFunction.create({
          name: `fails_in_${stage}`,
          bindFunction: (info) => {
            info.addResultColumn("c", INTEGER);
            if (stage === "bind") info.setError("bind refused");
          },
          initFunction: (info) => {
            if (stage === "init") info.setError("init refused");
          },
          mainFunction: (_info, output) => {
            output.rowCount = 0;
          },
        });
      connection.registerTableFunction(failing("bind"));
      connection.registerTableFunction(failing("init"));
      await expect(connection.run("SELECT * FROM fails_in_bind()")).rejects.toThrow("bind refused");
      await expect(connection.run("SELECT * FROM fails_in_init()")).rejects.toThrow("init refused");
    });
  });
});
