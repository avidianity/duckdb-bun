// Date, time, hugeint and decimal helpers of the new bindings: the N-API
// coercions the official binding applies to number arguments, and its type and
// range errors.

import { expect, test } from "bun:test";
import * as dt from "../../src/bindings/api/datetime.ts";

test("create_time_tz coerces micros like Int64Value and offset like Int32Value", () => {
  const bits = (micros: bigint, offset: number) => (micros << 24n) + BigInt(57599 - offset);
  expect(dt.create_time_tz(45296789123.9, 0)).toStrictEqual({ bits: bits(45296789123n, 0) });
  expect(dt.create_time_tz(Number.NaN, Number.NaN)).toStrictEqual({ bits: bits(0n, 0) });
  // 2^32 + 5 wraps to 5, as ToInt32 does.
  expect(dt.create_time_tz(0, 2 ** 32 + 5)).toStrictEqual({ bits: bits(0n, 5) });
  expect(() => dt.create_time_tz("1" as never, 0)).toThrow(new Error("A number was expected"));
});

test("double_to_decimal narrows width and scale through Uint32Value to uint8", () => {
  expect(dt.double_to_decimal(1, 256 + 9, 4)).toStrictEqual({ width: 9, scale: 4, value: 10000n });
  expect(dt.double_to_decimal(1, 9.7, 4.2)).toStrictEqual({ width: 9, scale: 4, value: 10000n });
  expect(() => dt.double_to_decimal(1, 9n as never, 4)).toThrow(new Error("A number was expected"));
});

test("hugeint conversions keep 128-bit values exact, including -2^64", () => {
  // The official MakeBigIntFromHugeInt returns 0n for -2^64 (upper -1, lower 0).
  expect(dt.double_to_hugeint(-(2 ** 64))).toBe(-(2n ** 64n));
  expect(dt.hugeint_to_double(-(2n ** 64n))).toBe(-(2 ** 64));
  // A magnitude of exactly 2^127 fits two words, so it wraps as GetHugeIntFromBigInt does.
  expect(dt.hugeint_to_double(2n ** 127n)).toBe(-(2 ** 127));
  expect(() => dt.hugeint_to_double(2n ** 128n)).toThrow(new Error("bigint out of hugeint range"));
  expect(() => dt.hugeint_to_double(1 as never)).toThrow(new Error("A bigint was expected"));
  expect(dt.double_to_uhugeint(2 ** 100)).toBe(2n ** 100n);
});

test("struct fields report their name and N-API's type errors", () => {
  expect(() => dt.from_date({ days: 2 ** 31 })).toThrow(new Error("days out of int32 range"));
  expect(() => dt.from_date({ days: 1n } as never)).toThrow(new Error("A number was expected"));
  expect(() => dt.from_time({ micros: 1 } as never)).toThrow(new Error("A bigint was expected"));
  expect(() => dt.is_finite_timestamp_ms({ millis: 2n ** 63n })).toThrow(new Error("millis out of int64 range"));
  expect(() => dt.to_timestamp({ date: { year: 1, month: 1, day: 1 } } as never)).toThrow(
    new Error("An object was expected"),
  );
  expect(dt.from_time_tz({ bits: 2n ** 64n - 1n }).time).toBeDefined();
});
