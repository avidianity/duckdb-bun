// The C++ exception boundary (native/cpp/boundary.hpp, docs/adr/0003): a libduckdb
// call that throws a C++ exception throws DuckDB's message as an Error, where it
// used to abort the process, and leaves the binding working.

import { describe, expect, test } from "bun:test";
import * as dt from "../../src/bindings/api/datetime.ts";
import * as v from "../../src/bindings/api/values.ts";
import { exceptionMessage } from "../../src/bindings/runtime/exception.ts";
import { DuckDBDateValue, DuckDBInstance, DuckDBTimestampTZValue, DuckDBTimestampValue } from "../../src/neo.ts";

const MIDNIGHT = { hour: 0, min: 0, sec: 0, micros: 0 };

describe("the public API", () => {
  test("DuckDBDateValue.fromParts with an invalid date throws DuckDB's error", () => {
    expect(() => DuckDBDateValue.fromParts({ year: 2025, month: 0, day: 1 })).toThrow(
      new Error("Conversion Error: Date out of range: 2025-0-1"),
    );
    expect(() => DuckDBDateValue.fromParts({ year: 2025, month: 2, day: 30 })).toThrow(
      new Error("Conversion Error: Date out of range: 2025-2-30"),
    );
    expect(String(DuckDBDateValue.fromParts({ year: 2025, month: 2, day: 28 }))).toBe("2025-02-28");
  });

  test("the timestamp fromParts throw DuckDB's error for an invalid date", () => {
    const parts = { date: { year: 2025, month: 13, day: 1 }, time: MIDNIGHT };
    const error = new Error("Conversion Error: Date out of range: 2025-13-1");
    expect(() => DuckDBTimestampValue.fromParts(parts)).toThrow(error);
    expect(() => DuckDBTimestampTZValue.fromParts(parts)).toThrow(error);
  });

  test("the thrown error is a plain Error, and queries keep working after it", async () => {
    let caught: unknown;
    try {
      DuckDBDateValue.fromParts({ year: 2025, month: 0, day: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).constructor).toBe(Error);
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    const reader = await connection.runAndReadAll("SELECT DATE '2025-01-02' AS d");
    expect(String(reader.getRows()[0]?.[0])).toBe("2025-01-02");
    connection.closeSync();
    instance.closeSync();
  });
});

describe("the raw bindings", () => {
  test("to_date and to_timestamp throw DuckDB's error", () => {
    expect(() => dt.to_date({ year: 2025, month: 0, day: 1 })).toThrow(
      new Error("Conversion Error: Date out of range: 2025-0-1"),
    );
    expect(() => dt.to_timestamp({ date: { year: 2025, month: 2, day: 30 }, time: MIDNIGHT })).toThrow(
      new Error("Conversion Error: Date out of range: 2025-2-30"),
    );
    expect(dt.to_date({ year: 2025, month: 1, day: 1 })).toEqual({ days: 20089 });
  });

  test("get_blob and get_bignum on a value that does not cast throw DuckDB's error", () => {
    expect(() => v.get_blob(v.create_int64(7n))).toThrow(
      new Error("Invalid Input Error: Failed to cast value: Unimplemented type for cast (BIGINT -> BLOB)"),
    );
    expect(() => v.get_bignum(v.create_varchar("abc"))).toThrow(
      new Error("Invalid Input Error: Failed to cast value: Could not convert string 'abc' to BIGNUM"),
    );
    expect(v.get_bignum(v.create_int64(7n))).toBe(7n);
  });
});

describe("exceptionMessage, as DuckDB's ErrorData builds it", () => {
  test("a DuckDB exception's JSON what()", () => {
    expect(exceptionMessage('{"exception_type":"Conversion","exception_message":"Date out of range: 2025-0-1"}')).toBe(
      "Conversion Error: Date out of range: 2025-0-1",
    );
    expect(exceptionMessage('{"exception_type":"Invalid Input","exception_message":"x","extra":"y"}')).toBe(
      "Invalid Input Error: x",
    );
  });

  test("the unknown type has no prefix, and an unrecognised type reads as Invalid", () => {
    expect(exceptionMessage('{"exception_type":"Unknown Type","exception_message":"x"}')).toBe("Error: x");
    expect(exceptionMessage('{"exception_type":"Nonsense","exception_message":"x"}')).toBe("Invalid Error: x");
  });

  test("an internal error carries DuckDB's assertion text", () => {
    expect(exceptionMessage('{"exception_type":"INTERNAL","exception_message":"x"}')).toStartWith(
      "INTERNAL Error: x\nThis error signals an assertion failure within DuckDB.",
    );
  });

  test("other exceptions", () => {
    expect(exceptionMessage("std::bad_alloc")).toBe("Out of Memory Error: Allocation failure");
    expect(exceptionMessage("vector::_M_range_check")).toBe("Invalid Error: vector::_M_range_check");
    expect(exceptionMessage("{not json")).toBe("Invalid Error: {not json");
    expect(exceptionMessage('{"exception_type":"IO","exception_message":"a\\u0000b"}')).toBe("IO Error: a\\0b");
    expect(exceptionMessage(null)).toBe("Error: a C++ exception that is not a std::exception");
  });
});
