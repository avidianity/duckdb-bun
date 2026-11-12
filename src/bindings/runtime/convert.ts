// JavaScript argument checks and conversions, ported from the official binding's
// bindings/src/conversion_helpers.h (vendored tag), with the same error text.
// Where the official binding gets a JS value through a node-addon-api cast, a
// value of the wrong JS type fails with N-API's own message, such as
// "A number was expected", and these helpers throw the same.

// --- N-API type expectations ----------------------------------------------------------

export function expectNumber(value: unknown): number {
  if (typeof value !== "number") throw new Error("A number was expected");
  return value;
}

export function expectBigInt(value: unknown): bigint {
  if (typeof value !== "bigint") throw new Error("A bigint was expected");
  return value;
}

export function expectString(value: unknown): string {
  if (typeof value !== "string") throw new Error("A string was expected");
  return value;
}

export function expectBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("A boolean was expected");
  return value;
}

export function expectObject(value: unknown): Record<string, unknown> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new Error("An object was expected");
  }
  return value as Record<string, unknown>;
}

export function expectArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("An array was expected");
  return value;
}

// --- N-API number coercions ------------------------------------------------------------
// The official binding reads some numbers with node-addon-api's lossy accessors
// rather than GetIntegerFromNumber; these reproduce what each accessor returns.

/** Number::Int32Value: ToInt32, so fractions truncate, values wrap modulo 2^32, and NaN and infinities read as 0. */
export function int32FromNumber(value: unknown): number {
  return expectNumber(value) | 0;
}

/** Number::Uint32Value: ToUint32, so a negative index arrives as a large unsigned one. */
export function uint32FromNumber(value: unknown): number {
  return expectNumber(value) >>> 0;
}

const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);

/** Number::Int64Value: truncates, saturates at the int64 bounds, and reads NaN and infinities as 0. */
export function int64FromNumber(value: unknown): bigint {
  const number = expectNumber(value);
  if (!Number.isFinite(number)) return 0n;
  if (number >= 2 ** 63) return INT64_MAX;
  if (number <= -(2 ** 63)) return INT64_MIN;
  return BigInt(Math.trunc(number));
}

/** node-addon-api's Function cast, as the official binding makes before it stores a callback. */
export function expectFunction<T>(value: T): T {
  if (typeof value !== "function") throw new Error("A function was expected");
  return value;
}

// --- bounds -------------------------------------------------------------------------------

export function throwIndexOutOfRange(index: number | bigint, count: number | bigint, what: string): never {
  throw new RangeError(`${what} index ${index} is out of range (count: ${count})`);
}

export function checkIndexInRange(index: number, count: number, what: string): void {
  if (index >= count) throwIndexOutOfRange(index, count, what);
}

export function checkOneBasedIndexInRange(index: number, count: number, what: string): void {
  if (index < 1 || index > count) throwIndexOutOfRange(index, count, what);
}

/** Call before handing a row index to a duckdb_validity_* function, which indexes the mask unchecked. */
export function checkValidityRowInRange(mask: Uint8Array, rowIndex: number): void {
  const rowCount = mask.byteLength * 8;
  if (rowIndex >= rowCount) {
    throw new RangeError(
      `row index ${rowIndex} is out of range for a validity mask of ${mask.byteLength} bytes (${rowCount} rows)`,
    );
  }
}

// --- fixed-width integers from JS numbers ---------------------------------------------

const INTEGER_RANGES = {
  int8: [-128, 127],
  int16: [-32768, 32767],
  int32: [-2147483648, 2147483647],
  uint8: [0, 255],
  uint16: [0, 65535],
  uint32: [0, 4294967295],
} as const;

export type IntegerType = keyof typeof INTEGER_RANGES;

/** Rejects any number that does not fit `type` exactly, as GetIntegerFromNumber does. */
export function integerFromNumber(value: unknown, type: IntegerType, valueName = "number"): number {
  const number = expectNumber(value);
  if (!Number.isFinite(number) || number !== Math.trunc(number)) throw new Error(`${valueName} is not an integer`);
  const [min, max] = INTEGER_RANGES[type];
  if (number < min || number > max) throw new Error(`${valueName} out of ${type} range`);
  return number;
}

/**
 * An unsigned 64-bit index or count from a JS number, as node-addon-api's
 * Number::Int64Value then a cast to idx_t: fractions truncate and a negative
 * value wraps, so callers range-check the result against a count.
 */
export function indexFromNumber(value: unknown): number {
  const number = Math.trunc(expectNumber(value));
  return Number.isFinite(number) ? number : 0;
}

// --- 64-bit and wider integers from BigInts -----------------------------------------------

/** An int64 from a BigInt, rejecting a lossy conversion with `${name} out of int64 range`. */
export function int64FromBigInt(value: unknown, name: string): bigint {
  const big = expectBigInt(value);
  if (BigInt.asIntN(64, big) !== big) throw new Error(`${name} out of int64 range`);
  return big;
}

export function uint64FromBigInt(value: unknown, name: string): bigint {
  const big = expectBigInt(value);
  if (BigInt.asUintN(64, big) !== big) throw new Error(`${name} out of uint64 range`);
  return big;
}

const TWO_128 = 1n << 128n;

/**
 * A hugeint from a BigInt. Like GetHugeIntFromBigInt, it rejects a magnitude
 * wider than 128 bits and wraps anything narrower into the 128-bit two's
 * complement range.
 */
export function hugeintFromBigInt(value: unknown): bigint {
  const big = expectBigInt(value);
  if ((big < 0n ? -big : big) >= TWO_128) throw new Error("bigint out of hugeint range");
  return BigInt.asIntN(128, big);
}

export function uhugeintFromBigInt(value: unknown): bigint {
  const big = expectBigInt(value);
  if (big < 0n || big >= TWO_128) throw new Error("bigint out of uhugeint range");
  return big;
}

// --- struct objects ------------------------------------------------------------------------

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export interface TimeParts {
  hour: number;
  min: number;
  sec: number;
  micros: number;
}

export function dateFromObject(value: unknown): { days: number } {
  return { days: integerFromNumber(expectObject(value).days, "int32", "days") };
}

export function datePartsFromObject(value: unknown): DateParts {
  const object = expectObject(value);
  return {
    year: integerFromNumber(object.year, "int32", "year"),
    month: integerFromNumber(object.month, "int8", "month"),
    day: integerFromNumber(object.day, "int8", "day"),
  };
}

export function timeFromObject(value: unknown): { micros: bigint } {
  return { micros: int64FromBigInt(expectObject(value).micros, "micros") };
}

export function timePartsFromObject(value: unknown): TimeParts {
  const object = expectObject(value);
  return {
    hour: integerFromNumber(object.hour, "int8", "hour"),
    min: integerFromNumber(object.min, "int8", "min"),
    sec: integerFromNumber(object.sec, "int8", "sec"),
    micros: integerFromNumber(object.micros, "int32", "micros"),
  };
}

export function timeNsFromObject(value: unknown): { nanos: bigint } {
  return { nanos: int64FromBigInt(expectObject(value).nanos, "nanos") };
}

export function timeTzFromObject(value: unknown): { bits: bigint } {
  return { bits: uint64FromBigInt(expectObject(value).bits, "bits") };
}

export function timestampFromObject(value: unknown): { micros: bigint } {
  return { micros: int64FromBigInt(expectObject(value).micros, "micros") };
}

export function timestampSecondsFromObject(value: unknown): { seconds: bigint } {
  return { seconds: int64FromBigInt(expectObject(value).seconds, "seconds") };
}

export function timestampMillisecondsFromObject(value: unknown): { millis: bigint } {
  return { millis: int64FromBigInt(expectObject(value).millis, "millis") };
}

export function timestampNanosecondsFromObject(value: unknown): { nanos: bigint } {
  return { nanos: int64FromBigInt(expectObject(value).nanos, "nanos") };
}

export function timestampPartsFromObject(value: unknown): { date: DateParts; time: TimeParts } {
  const object = expectObject(value);
  return { date: datePartsFromObject(object.date), time: timePartsFromObject(object.time) };
}

export function intervalFromObject(value: unknown): { months: number; days: number; micros: bigint } {
  const object = expectObject(value);
  return {
    months: integerFromNumber(object.months, "int32", "months"),
    days: integerFromNumber(object.days, "int32", "days"),
    micros: int64FromBigInt(object.micros, "micros"),
  };
}

export function decimalFromObject(value: unknown): { width: number; scale: number; value: bigint } {
  const object = expectObject(value);
  return {
    width: integerFromNumber(object.width, "uint8", "width"),
    scale: integerFromNumber(object.scale, "uint8", "scale"),
    value: hugeintFromBigInt(object.value),
  };
}

// --- bignum ----------------------------------------------------------------------------------

/**
 * The big-endian magnitude bytes and sign of a BigInt, padded to whole 64-bit
 * words as GetBigNumFromBigInt does. Zero is one zero byte rather than the
 * official binding's empty array: DuckDB's Bignum::FromByteArray throws a C++
 * exception for an empty array, which aborts the process.
 */
export function bignumFromBigInt(value: unknown): { bytes: Uint8Array; isNegative: boolean } {
  const big = expectBigInt(value);
  if (big === 0n) return { bytes: new Uint8Array(1), isNegative: false };
  const isNegative = big < 0n;
  let magnitude = isNegative ? -big : big;
  let wordCount = 0;
  for (let rest = magnitude; rest > 0n; rest >>= 64n) wordCount++;
  const bytes = new Uint8Array(wordCount * 8);
  for (let i = bytes.length - 1; i >= 0; i--) {
    bytes[i] = Number(magnitude & 0xffn);
    magnitude >>= 8n;
  }
  return { bytes, isNegative };
}

/**
 * The BigInt for big-endian magnitude bytes of any length. The official
 * MakeBigIntFromBigNum reads only size / 8 whole words, so it returns a wrong
 * value for every bignum whose byte count is not a multiple of 8, which is
 * every bignum DuckDB produces itself (`1::BIGNUM` has one byte).
 */
export function bigIntFromBignum(bytes: Uint8Array, isNegative: boolean): bigint {
  let magnitude = 0n;
  for (const byte of bytes) magnitude = (magnitude << 8n) | BigInt(byte);
  return isNegative ? -magnitude : magnitude;
}
