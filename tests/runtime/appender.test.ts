// The appender family of the new bindings (src/bindings/api/appender.ts):
// every C type round-trips, and failures throw DuckDB's appender error or the
// official binding's own messages.

import { afterAll, beforeAll, expect, test } from "bun:test";
import duckdb, { type Connection, type Database, Type } from "../../src/bindings/index.ts";

let database: Database;
let connection: Connection;

beforeAll(async () => {
  database = await duckdb.open();
  connection = await duckdb.connect(database);
});

afterAll(() => {
  duckdb.disconnect_sync(connection);
  duckdb.close_sync(database);
});

async function firstRowAsText(sql: string): Promise<string> {
  const result = await duckdb.query(connection, `SELECT (${sql})::VARCHAR`);
  const chunk = await duckdb.fetch_chunk(result);
  const data = duckdb.vector_get_data(duckdb.data_chunk_get_vector(chunk as never, 0), 16);
  const length = new DataView(data.buffer).getUint32(0, true);
  const bytes =
    length <= 12 ? data.subarray(4, 4 + length) : duckdb.get_data_from_pointer(data.buffer as ArrayBuffer, 8, length);
  return new TextDecoder().decode(bytes);
}

test("every append function writes its type", async () => {
  await duckdb.query(
    connection,
    `CREATE TABLE every_type (b BOOLEAN, i8 TINYINT, i16 SMALLINT, i32 INTEGER, i64 BIGINT, h HUGEINT,
      u8 UTINYINT, u16 USMALLINT, u32 UINTEGER, u64 UBIGINT, uh UHUGEINT, f FLOAT, d DOUBLE, dt DATE,
      t TIME, ts TIMESTAMP, iv INTERVAL, s VARCHAR, bl BLOB, n INTEGER, v INTEGER, df INTEGER DEFAULT 5)`,
  );
  const appender = duckdb.appender_create(connection, null, "every_type");
  expect(duckdb.appender_column_count(appender)).toBe(22);
  expect(duckdb.get_type_id(duckdb.appender_column_type(appender, 4))).toBe(Type.BIGINT);
  duckdb.append_bool(appender, true);
  duckdb.append_int8(appender, -128);
  duckdb.append_int16(appender, 32767);
  duckdb.append_int32(appender, -5);
  duckdb.append_int64(appender, -(2n ** 63n));
  duckdb.append_hugeint(appender, -(2n ** 100n));
  duckdb.append_uint8(appender, 255);
  duckdb.append_uint16(appender, 65535);
  duckdb.append_uint32(appender, 4294967295);
  duckdb.append_uint64(appender, 2n ** 64n - 1n);
  duckdb.append_uhugeint(appender, 2n ** 128n - 1n);
  duckdb.append_float(appender, 1.5);
  duckdb.append_double(appender, -2.25);
  duckdb.append_date(appender, { days: 19000 });
  duckdb.append_time(appender, { micros: 3_600_000_001n });
  duckdb.append_timestamp(appender, { micros: 1_700_000_000_000_000n });
  duckdb.append_interval(appender, { months: 1, days: 2, micros: 3n });
  duckdb.append_varchar(appender, "héllo");
  duckdb.append_blob(appender, new Uint8Array([0, 255]));
  duckdb.append_null(appender);
  duckdb.append_value(appender, duckdb.create_int32(77));
  duckdb.append_default(appender);
  duckdb.appender_end_row(appender);
  duckdb.appender_flush_sync(appender);
  duckdb.appender_close_sync(appender);

  const row = await firstRowAsText(
    `SELECT concat_ws('|', b, i8, i16, i32, i64, h, u8, u16, u32, u64, uh, f, d, dt, t, ts, iv, s, bl,
      coalesce(n::VARCHAR, 'null'), v, df) FROM every_type`,
  );
  expect(row).toBe(
    [
      "true",
      "-128",
      "32767",
      "-5",
      "-9223372036854775808",
      "-1267650600228229401496703205376",
      "255",
      "65535",
      "4294967295",
      "18446744073709551615",
      "340282366920938463463374607431768211455",
      "1.5",
      "-2.25",
      "2022-01-08",
      "01:00:00.000001",
      "2023-11-14 22:13:20",
      "1 month 2 days 00:00:00.000003",
      "héllo",
      "\\x00\\xFF",
      "null",
      "77",
      "5",
    ].join("|"),
  );
});

test("append_data_chunk appends a whole chunk", async () => {
  await duckdb.query(connection, "CREATE TABLE from_chunk (i INTEGER)");
  const chunk = duckdb.create_data_chunk([duckdb.create_logical_type(Type.INTEGER)]);
  duckdb.data_chunk_set_size(chunk, 3);
  duckdb.copy_data_to_vector(duckdb.data_chunk_get_vector(chunk, 0), 0, new Int32Array([1, 2, 3]).buffer, 0, 12);
  const appender = duckdb.appender_create_ext(connection, "memory", "main", "from_chunk");
  duckdb.append_data_chunk(appender, chunk);
  duckdb.appender_close_sync(appender);
  expect(await firstRowAsText("SELECT sum(i) FROM from_chunk")).toBe("6");
});

test("failures throw DuckDB's appender error or the official message", async () => {
  expect(() => duckdb.appender_create_ext(connection, "memory", null, "no_such_table")).toThrow(
    "Table 'memory.main.no_such_table' could not be found",
  );
  await duckdb.query(connection, "CREATE TABLE two (a INTEGER, b INTEGER)");
  const appender = duckdb.appender_create(connection, "main", "two");
  expect(() => duckdb.appender_column_type(appender, 2)).toThrow(
    new RangeError("column index 2 is out of range (count: 2)"),
  );
  duckdb.append_int32(appender, 1);
  expect(() => duckdb.appender_end_row(appender)).toThrow(/Call to EndRow before all columns have been appended to!/);
  duckdb.appender_clear(appender);
  expect(() => duckdb.append_int8(appender, 128)).toThrow(new Error("number out of int8 range"));
  expect(() => duckdb.append_int32(appender, 1.5)).toThrow(new Error("number is not an integer"));
  expect(() => duckdb.append_int64(appender, 1 as never)).toThrow(new Error("A bigint was expected"));
  expect(() => duckdb.append_int64(appender, 2n ** 63n)).toThrow(new Error("bigint out of int64 range"));
  expect(() => duckdb.append_varchar(appender, 1 as never)).toThrow(new Error("A string was expected"));
  expect(() => duckdb.append_bool(connection as never, true)).toThrow(new Error("Invalid appender argument"));

  const other = await duckdb.connect(database);
  duckdb.disconnect_sync(other);
  expect(() => duckdb.appender_create(other, null, "two")).toThrow(
    new Error("Failed to create appender: connection disconnected"),
  );
});
