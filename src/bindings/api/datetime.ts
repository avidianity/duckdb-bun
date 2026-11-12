// Date, time, timestamp, hugeint and decimal helpers of the @duckdb/node-bindings
// contract. Each one converts its argument as the official binding does
// (bindings/src/duckdb_node_bindings.cpp and conversion_helpers.h at the fork
// tag), then calls the shim's by-value wrapper of the C function.
import type {
  Date_,
  DateParts,
  Decimal,
  Time,
  TimeParts,
  Timestamp,
  TimestampMilliseconds,
  TimestampNanoseconds,
  TimestampParts,
  TimestampSeconds,
  TimeTZ,
  TimeTZParts,
} from "../generated/contract.ts";
import {
  dateFromObject,
  datePartsFromObject,
  decimalFromObject,
  expectNumber,
  hugeintFromBigInt,
  int32FromNumber,
  int64FromNumber,
  timeFromObject,
  timePartsFromObject,
  timestampFromObject,
  timestampMillisecondsFromObject,
  timestampNanosecondsFromObject,
  timestampPartsFromObject,
  timestampSecondsFromObject,
  timeTzFromObject,
  uhugeintFromBigInt,
  uint32FromNumber,
} from "../runtime/convert.ts";
import { decode, encode, structBuffer } from "../runtime/marshal.ts";
import { shim } from "../runtime/native.ts";

// --- date and time ------------------------------------------------------------------

export function from_date(date: Date_): DateParts {
  const out = structBuffer("date_struct");
  shim.dbs_from_date(encode("date", dateFromObject(date)), out);
  return decode<DateParts>("date_struct", out);
}

export function to_date(parts: DateParts): Date_ {
  const out = structBuffer("date");
  shim.dbs_to_date(encode("date_struct", datePartsFromObject(parts)), out);
  return decode<Date_>("date", out);
}

export function is_finite_date(date: Date_): boolean {
  return shim.dbs_is_finite_date(encode("date", dateFromObject(date)));
}

export function from_time(time: Time): TimeParts {
  const out = structBuffer("time_struct");
  shim.dbs_from_time(encode("time", timeFromObject(time)), out);
  return decode<TimeParts>("time_struct", out);
}

/** micros and offset go through Number::Int64Value and Number::Int32Value, which coerce rather than reject. */
export function create_time_tz(micros: number, offset: number): TimeTZ {
  const micros64 = int64FromNumber(micros);
  const offset32 = int32FromNumber(offset);
  const out = structBuffer("time_tz");
  shim.dbs_create_time_tz(micros64, offset32, out);
  return decode<TimeTZ>("time_tz", out);
}

export function from_time_tz(time_tz: TimeTZ): TimeTZParts {
  const out = structBuffer("time_tz_struct");
  shim.dbs_from_time_tz(encode("time_tz", timeTzFromObject(time_tz)), out);
  return decode<TimeTZParts>("time_tz_struct", out);
}

export function to_time(parts: TimeParts): Time {
  const out = structBuffer("time");
  shim.dbs_to_time(encode("time_struct", timePartsFromObject(parts)), out);
  return decode<Time>("time", out);
}

export function from_timestamp(timestamp: Timestamp): TimestampParts {
  const out = structBuffer("timestamp_struct");
  shim.dbs_from_timestamp(encode("timestamp", timestampFromObject(timestamp)), out);
  return decode<TimestampParts>("timestamp_struct", out);
}

export function to_timestamp(parts: TimestampParts): Timestamp {
  const out = structBuffer("timestamp");
  shim.dbs_to_timestamp(encode("timestamp_struct", timestampPartsFromObject(parts)), out);
  return decode<Timestamp>("timestamp", out);
}

export function is_finite_timestamp(timestamp: Timestamp): boolean {
  return shim.dbs_is_finite_timestamp(encode("timestamp", timestampFromObject(timestamp)));
}

export function is_finite_timestamp_s(timestampSeconds: TimestampSeconds): boolean {
  return shim.dbs_is_finite_timestamp_s(encode("timestamp_s", timestampSecondsFromObject(timestampSeconds)));
}

export function is_finite_timestamp_ms(timestampMilliseconds: TimestampMilliseconds): boolean {
  return shim.dbs_is_finite_timestamp_ms(
    encode("timestamp_ms", timestampMillisecondsFromObject(timestampMilliseconds)),
  );
}

export function is_finite_timestamp_ns(timestampNanoseconds: TimestampNanoseconds): boolean {
  return shim.dbs_is_finite_timestamp_ns(encode("timestamp_ns", timestampNanosecondsFromObject(timestampNanoseconds)));
}

// --- hugeint, uhugeint and decimal ------------------------------------------------------

export function hugeint_to_double(hugeint: bigint): number {
  return shim.dbs_hugeint_to_double(encode("hugeint", hugeintFromBigInt(hugeint)));
}

/** DuckDB returns 0 for a double outside the hugeint range. */
export function double_to_hugeint(double: number): bigint {
  const input = expectNumber(double);
  const out = structBuffer("hugeint");
  shim.dbs_double_to_hugeint(input, out);
  return decode<bigint>("hugeint", out);
}

export function uhugeint_to_double(uhugeint: bigint): number {
  return shim.dbs_uhugeint_to_double(encode("uhugeint", uhugeintFromBigInt(uhugeint)));
}

/** DuckDB returns 0 for a double outside the uhugeint range, negative ones included. */
export function double_to_uhugeint(double: number): bigint {
  const input = expectNumber(double);
  const out = structBuffer("uhugeint");
  shim.dbs_double_to_uhugeint(input, out);
  return decode<bigint>("uhugeint", out);
}

/**
 * width and scale go through Number::Uint32Value and then narrow to uint8_t, as
 * in the official binding. DuckDB returns a zeroed decimal when the value does
 * not fit.
 */
export function double_to_decimal(double: number, width: number, scale: number): Decimal {
  const input = expectNumber(double);
  const width8 = uint32FromNumber(width) & 0xff;
  const scale8 = uint32FromNumber(scale) & 0xff;
  const out = structBuffer("decimal");
  shim.dbs_double_to_decimal(input, width8, scale8, out);
  return decode<Decimal>("decimal", out);
}

export function decimal_to_double(decimal: Decimal): number {
  return shim.dbs_decimal_to_double(encode("decimal", decimalFromObject(decimal)));
}
