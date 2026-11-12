// Value functions of the new bindings: byte buffers in and out, nested values,
// failure messages, and the value type a value lends out.

import { expect, test } from "bun:test";
import * as db from "../../src/bindings/api/database.ts";
import * as lt from "../../src/bindings/api/logical-types.ts";
import * as v from "../../src/bindings/api/values.ts";
import { Type } from "../../src/bindings/generated/contract.ts";
import { DuckDBBitValue, DuckDBInstance } from "../../src/neo.ts";

test("blobs and bits come back as Buffers holding exactly the bytes given", () => {
  const backing = new Uint8Array([9, 9, 1, 0, 2, 9]);
  expect(v.get_blob(v.create_blob(backing.subarray(2, 5)))).toStrictEqual(Buffer.from([1, 0, 2]));
  expect(v.get_blob(v.create_blob(new Uint8Array(0)))).toStrictEqual(Buffer.alloc(0));
  // node-addon-api's Uint8Array cast reads any TypedArray by its byte length.
  expect(v.get_blob(v.create_blob(new Uint16Array([0x0201]) as never))).toStrictEqual(Buffer.from([1, 2]));
  expect(() => v.create_blob(new DataView(new ArrayBuffer(1)) as never)).toThrow(new Error("Invalid argument"));
  expect(() => v.create_blob([1] as never)).toThrow(new Error("Invalid argument"));
  const bits = Buffer.from([3, 0b11110000]);
  expect(v.get_bit(v.create_bit(bits))).toStrictEqual(bits);
  expect(v.get_varchar(v.create_bit(bits))).toBe("10000");
});

test("bignums round-trip at word boundaries and zero", () => {
  // The official create_bignum(0n) aborts the process with a C++ exception.
  for (const input of [0n, 1n, -1n, 2n ** 64n - 1n, -(2n ** 64n), 2n ** 200n + 12345n]) {
    expect(v.get_bignum(v.create_bignum(input))).toBe(input);
  }
});

test("bignums DuckDB encodes in fewer than whole words read correctly", () => {
  // DuckDB stores these in 1, 1, 1 and 9 bytes; the official get_bignum reads
  // only whole 8-byte words, so it returns 0n for all of them.
  for (const text of ["0", "1", "-1", "18446744073709551616"]) {
    expect(v.get_bignum(v.create_varchar(text))).toBe(BigInt(text));
  }
});

test("wide integers and their range errors", () => {
  expect(v.get_hugeint(v.create_hugeint(-(2n ** 64n)))).toBe(-(2n ** 64n));
  expect(v.get_uuid(v.create_uuid(0n))).toBe(0n);
  expect(() => v.create_int64(2n ** 63n)).toThrow(new Error("bigint out of int64 range"));
  expect(() => v.create_uint64(-1n)).toThrow(new Error("bigint out of uint64 range"));
  expect(() => v.create_uhugeint(-1n)).toThrow(new Error("bigint out of uhugeint range"));
  expect(() => v.create_int64(1 as never)).toThrow(new Error("A bigint was expected"));
  expect(v.get_int64(v.create_int64(-(2n ** 63n)))).toBe(-(2n ** 63n));
});

test("scalar arguments fail with N-API's type errors", () => {
  expect(() => v.create_bool(1 as never)).toThrow(new Error("A boolean was expected"));
  expect(() => v.create_varchar(1 as never)).toThrow(new Error("A string was expected"));
  expect(() => v.create_double("1" as never)).toThrow(new Error("A number was expected"));
  expect(() => v.create_int32(1.5)).toThrow(new Error("number is not an integer"));
  expect(() => v.get_int32(lt.create_logical_type(Type.INTEGER) as never)).toThrow(new Error("Invalid value argument"));
});

test("varchar keeps embedded NUL bytes, empty strings and non-ASCII text", () => {
  expect(v.get_varchar(v.create_varchar(""))).toBe("");
  expect(v.get_varchar(v.create_varchar("ünïcødé 🦆"))).toBe("ünïcødé 🦆");
  expect(v.get_blob(v.create_varchar("a\0b"))).toStrictEqual(Buffer.from("a\0b"));
});

test("a struct value with fewer values than children fails instead of reading past the array", () => {
  const int = lt.create_logical_type(Type.INTEGER);
  const structType = lt.create_struct_type([int, int], ["a", "b"]);
  expect(() => v.create_struct_value(structType, [v.create_int32(1)])).toThrow(
    new Error("Failed to create struct value"),
  );
  const struct = v.create_struct_value(structType, [v.create_int32(1), v.create_int32(2)]);
  expect(v.get_int32(v.get_struct_child(struct, 1))).toBe(2);
  expect(() => v.get_struct_child(struct, 2)).toThrow(new Error("Failed to get struct child"));
});

test("out-of-range children fail with the official messages, a negative index included", () => {
  const int = lt.create_logical_type(Type.INTEGER);
  const list = v.create_list_value(int, [v.create_int32(7)]);
  expect(v.get_list_size(list)).toBe(1);
  expect(() => v.get_list_child(list, -1)).toThrow(new Error("Failed to get list child"));
  const map = v.create_map_value(lt.create_map_type(int, int), [v.create_int32(1)], [v.create_int32(2)]);
  expect(v.get_map_size(map)).toBe(1);
  expect(() => v.get_map_key(map, 1)).toThrow(new Error("Failed to get map key"));
  expect(() => v.get_map_value(map, 1)).toThrow(new Error("Failed to get map value"));
  expect(() => v.create_list_value(int, [int] as never)).toThrow(new Error("Invalid value argument"));
});

test("enum values take a strict uint32", () => {
  const enumType = lt.create_enum_type(["a", "b"]);
  expect(v.get_enum_value(v.create_enum_value(enumType, 1))).toBe(1);
  expect(() => v.create_enum_value(enumType, 2)).toThrow(new Error("Failed to create enum value"));
  expect(() => v.create_enum_value(enumType, -1)).toThrow(new Error("number out of uint32 range"));
});

test("a value's type stays usable while only the type is reachable", () => {
  let type = v.get_value_type(v.create_decimal({ width: 9, scale: 4, value: 12345n }));
  Bun.gc(true);
  expect(lt.decimal_width(type)).toBe(9);
  type = v.get_value_type(v.create_null_value());
  expect(lt.get_type_id(type)).toBe(Type.SQLNULL);
});

test("scalar getters refuse a NULL value with the official error instead of aborting the process", () => {
  const untyped = v.create_null_value();
  const typed = v.get_list_child(v.create_list_value(lt.create_logical_type(Type.INTEGER), [untyped]), 0);
  const thrown = new Error("A native exception was thrown");
  for (const value of [untyped, typed]) {
    expect(v.is_null_value(value)).toBe(true);
    expect(() => v.get_bool(value)).toThrow(thrown);
    expect(() => v.get_int32(value)).toThrow(thrown);
    expect(() => v.get_uint64(value)).toThrow(thrown);
    expect(() => v.get_double(value)).toThrow(thrown);
    expect(() => v.get_hugeint(value)).toThrow(thrown);
    expect(() => v.get_bignum(value)).toThrow(thrown);
    expect(() => v.get_date(value)).toThrow(thrown);
    expect(() => v.get_timestamp_ns(value)).toThrow(thrown);
    expect(() => v.get_interval(value)).toThrow(thrown);
    expect(() => v.get_blob(value)).toThrow(thrown);
    expect(() => v.get_uuid(value)).toThrow(thrown);
    expect(() => v.get_varchar(value)).toThrow(thrown);
    // duckdb_get_decimal reads a NULL value without throwing.
    expect(v.get_decimal(value)).toMatchObject({ width: expect.any(Number), scale: expect.any(Number) });
  }
});

test("the table names of SQL that does not parse fail in the scalar getters instead of crashing", async () => {
  const database = await db.open();
  const connection = await db.connect(database);
  // DuckDB returns no value for SQL that does not parse; the official binding
  // wraps that, and its scalar getters then die with SIGSEGV.
  const names = db.get_table_names(connection, "SELEC 1", false);
  expect(v.get_list_size(names)).toBe(0);
  const invalid = new Error("Invalid value argument");
  expect(() => v.get_varchar(names)).toThrow(invalid);
  expect(() => v.get_int32(names)).toThrow(invalid);
  expect(() => v.get_decimal(names)).toThrow(invalid);
  expect(() => v.get_blob(names)).toThrow(invalid);
  db.disconnect_sync(connection);
  db.close_sync(database);
});

// DuckDB keeps the padding, the bit string's first byte, below 8 and asserts it only in
// debug builds. A larger padding made its BIT to VARCHAR cast write past its buffer,
// which killed the process, in the official binding too; a padding over the bit
// count made it throw a C++ exception, which aborts the process through bun:ffi.
test("a bit string with an invalid padding fails instead of crashing the process", async () => {
  const invalid = [[], [1], [8, 0xff], [0x30, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]].map(
    (bytes) => new Uint8Array(bytes),
  );
  for (const bytes of invalid) {
    expect(() => v.create_bit(bytes)).toThrow(new Error("Failed to create bit value: invalid padding"));
  }
  expect(v.get_varchar(v.create_bit(new Uint8Array([0])))).toBe("");
  expect(v.get_varchar(v.create_bit(new Uint8Array([7, 0xff, 0x0f])))).toBe("100001111");

  const instance = await DuckDBInstance.create();
  const connection = await instance.connect();
  const bit = new DuckDBBitValue(new Uint8Array([0x30, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  await expect(connection.run("SELECT $1::VARCHAR AS v", [bit])).rejects.toThrow(
    "Failed to create bit value: invalid padding",
  );
  const valid = new DuckDBBitValue(new Uint8Array([2, 0xff]));
  expect((await connection.runAndReadAll("SELECT $1::VARCHAR AS v", [valid])).getRows()).toEqual([["111111"]]);
  connection.closeSync();
  instance.closeSync();
});
