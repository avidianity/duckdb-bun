// Generators for the value fuzz targets: a random DuckDB type, random values of it,
// and the three ways to express a value: a SQL literal, a JS value built with an
// implementation's `@duckdb/node-api` constructors, and that API's type object.
//
// A generated type and its raw values are plain data, independent of either
// implementation, so one case runs unchanged against the official package and ours.

import type * as official from "@duckdb/node-api";
import fc from "fast-check";

type Api = typeof official;
type DuckDBType = official.DuckDBType;
type DuckDBValue = official.DuckDBValue;

/** Every scalar type the C API exposes that `@duckdb/node-api` can read. */
export const SCALAR_KINDS = [
  "BOOLEAN",
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "HUGEINT",
  "UHUGEINT",
  "BIGNUM",
  "FLOAT",
  "DOUBLE",
  "VARCHAR",
  "BLOB",
  "DATE",
  "TIME",
  "TIME_NS",
  "TIMETZ",
  "TIMESTAMP",
  "TIMESTAMP_S",
  "TIMESTAMP_MS",
  "TIMESTAMP_NS",
  "TIMESTAMPTZ",
  "TIMESTAMPTZ_NS",
  "INTERVAL",
  "UUID",
  "BIT",
  "GEOMETRY",
] as const;
export type ScalarKind = (typeof SCALAR_KINDS)[number];

export type FuzzType =
  | { kind: ScalarKind }
  | { kind: "DECIMAL"; width: number; scale: number }
  | { kind: "ENUM"; values: string[] }
  | { kind: "LIST"; child: FuzzType }
  | { kind: "ARRAY"; child: FuzzType; size: number }
  | { kind: "STRUCT"; fields: [string, FuzzType][] }
  | { kind: "MAP"; key: FuzzType; value: FuzzType }
  | { kind: "UNION"; members: [string, FuzzType][] }
  | { kind: "VARIANT"; inner: FuzzType };

/** Every kind a generated type can have; the property tests report how often each one ran. */
export const ALL_KINDS = [
  ...SCALAR_KINDS,
  "DECIMAL",
  "ENUM",
  "LIST",
  "ARRAY",
  "STRUCT",
  "MAP",
  "UNION",
  "VARIANT",
] as const;

export interface TimeTZRaw {
  micros: bigint;
  offset: number;
}
export interface IntervalRaw {
  months: number;
  days: number;
  micros: bigint;
}

/**
 * A raw value: null, a JS primitive, a byte array, one of the small records above,
 * an array (LIST, ARRAY), a record (STRUCT), entries (MAP), or a tagged value (UNION).
 */
export type Raw =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | TimeTZRaw
  | IntervalRaw
  | Raw[]
  | { [field: string]: Raw }
  | { key: Raw; value: Raw }[]
  | { tag: string; value: Raw };

/** A table to round-trip: one type per column and rows of raw values. */
export interface FuzzCase {
  types: FuzzType[];
  rows: Raw[][];
}

const I64_MAX = 2n ** 63n - 1n;
const I64_MIN = -(2n ** 63n);
const DAY_MICROS = 86_400_000_000n;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Struct field, union tag, and enum names: any text without NUL that stays a plain object key. */
const nameArb = fc
  .string({
    minLength: 1,
    maxLength: 6,
    unit: fc.oneof(
      fc.constantFrom("a", "B", " ", "'", '"', "é", "😀"),
      fc.string({ minLength: 1, maxLength: 1, unit: "binary" }),
    ),
  })
  .filter((name) => !name.includes("\0") && !/^\d+$/.test(name) && name !== "__proto__");

/** Names unique without regard to case, as DuckDB requires for struct fields and union tags. */
const uniqueNames = (min: number, max: number) =>
  fc.uniqueArray(nameArb, { minLength: min, maxLength: max, selector: (name) => name.toLowerCase() });

const decimalArb = fc
  .oneof(
    fc.integer({ min: 1, max: 4 }), // int16 storage
    fc.integer({ min: 5, max: 9 }), // int32
    fc.integer({ min: 10, max: 18 }), // int64
    fc.integer({ min: 19, max: 38 }), // int128
  )
  .chain((width) => fc.integer({ min: 0, max: width }).map((scale) => ({ kind: "DECIMAL" as const, width, scale })));

const enumArb = fc
  .uniqueArray(nameArb, { minLength: 1, maxLength: 5 })
  .map((values) => ({ kind: "ENUM" as const, values }));

/** Map keys: types with a total, exact equality, so generated keys can be kept unique. */
const MAP_KEY_KINDS = [
  "TINYINT",
  "INTEGER",
  "BIGINT",
  "UBIGINT",
  "HUGEINT",
  "VARCHAR",
  "DATE",
  "UUID",
  "BOOLEAN",
] as const;

const leafTypeArb: fc.Arbitrary<FuzzType> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...SCALAR_KINDS).map((kind) => ({ kind })) },
  { weight: 1, arbitrary: decimalArb },
  { weight: 1, arbitrary: enumArb },
);

/** A random type, nested at most `depth` levels deep. */
export function typeArb(depth = 3): fc.Arbitrary<FuzzType> {
  const { type } = fc.letrec<{ type: FuzzType }>((tie) => ({
    type: fc.oneof(
      { depthSize: "small", maxDepth: depth, withCrossShrink: true },
      leafTypeArb,
      fc.record({ kind: fc.constant("LIST" as const), child: tie("type") }),
      fc.record({ kind: fc.constant("ARRAY" as const), child: tie("type"), size: fc.integer({ min: 1, max: 4 }) }),
      fc.record({
        kind: fc.constant("STRUCT" as const),
        fields: uniqueNames(1, 4).chain((names) =>
          fc.tuple(...names.map((name) => tie("type").map((t) => [name, t] as [string, FuzzType]))),
        ),
      }),
      fc.record({
        kind: fc.constant("MAP" as const),
        key: fc.constantFrom(...MAP_KEY_KINDS).map((kind) => ({ kind }) as FuzzType),
        value: tie("type"),
      }),
      fc.record({
        kind: fc.constant("UNION" as const),
        members: uniqueNames(1, 3).chain((names) =>
          fc.tuple(...names.map((name) => tie("type").map((t) => [name, t] as [string, FuzzType]))),
        ),
      }),
      fc.record({ kind: fc.constant("VARIANT" as const), inner: tie("type") }),
    ),
  }));
  return type;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const varcharArb = fc.oneof(
  fc.string({ maxLength: 12 }),
  // Longer than the 12-byte inline limit of a duckdb_string_t.
  fc.string({ minLength: 13, maxLength: 80, unit: "grapheme" }),
  // Any code point, NUL included, and surrogate pairs.
  fc.string({ maxLength: 40, unit: "binary" }),
  fc.string({ maxLength: 20, unit: fc.constantFrom("\0", "a", "é", "€", "😀", "\u{10FFFF}", "'", "\\", "\n") }),
);

const timestampArb = (min: bigint, max: bigint) =>
  fc.oneof(
    { weight: 4, arbitrary: fc.bigInt(min, max) },
    { weight: 1, arbitrary: fc.constantFrom(I64_MAX, -I64_MAX) }, // infinity, -infinity
  );

function scalarArb(kind: ScalarKind): fc.Arbitrary<Raw> {
  switch (kind) {
    case "BOOLEAN":
      return fc.boolean();
    case "TINYINT":
      return fc.integer({ min: -128, max: 127 });
    case "SMALLINT":
      return fc.integer({ min: -32768, max: 32767 });
    case "INTEGER":
      return fc.integer({ min: -2147483648, max: 2147483647 });
    case "UTINYINT":
      return fc.integer({ min: 0, max: 255 });
    case "USMALLINT":
      return fc.integer({ min: 0, max: 65535 });
    case "UINTEGER":
      return fc.integer({ min: 0, max: 4294967295 });
    case "BIGINT":
      return fc.bigInt(I64_MIN, I64_MAX);
    case "UBIGINT":
      return fc.bigInt(0n, 2n ** 64n - 1n);
    case "HUGEINT":
      return fc.bigInt(-(2n ** 127n), 2n ** 127n - 1n);
    case "UHUGEINT":
      return fc.bigInt(0n, 2n ** 128n - 1n);
    case "BIGNUM":
      return fc.oneof(fc.bigInt(-(2n ** 70n), 2n ** 70n), fc.bigInt(-(2n ** 400n), 2n ** 400n));
    case "FLOAT":
      return fc.float(); // NaN, +/-Infinity and -0 included
    case "DOUBLE":
      return fc.double();
    case "VARCHAR":
      return varcharArb;
    case "BLOB":
      return fc.uint8Array({ maxLength: 40 });
    case "DATE":
      return fc.oneof(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -2147483646, max: 2147483646 }),
        fc.constantFrom(2147483647, -2147483647), // infinity, -infinity
      );
    case "TIME":
      return fc.bigInt(0n, DAY_MICROS);
    case "TIME_NS":
      return fc.bigInt(0n, DAY_MICROS * 1000n);
    case "TIMETZ":
      return fc.record({ micros: fc.bigInt(0n, DAY_MICROS), offset: fc.integer({ min: -57599, max: 57599 }) });
    case "TIMESTAMP":
    case "TIMESTAMPTZ":
      return timestampArb(-(2n ** 62n), 2n ** 62n);
    case "TIMESTAMP_S":
      return timestampArb(-9_000_000_000_000n, 9_000_000_000_000n);
    case "TIMESTAMP_MS":
      return timestampArb(-9_000_000_000_000_000n, 9_000_000_000_000_000n);
    case "TIMESTAMP_NS":
    case "TIMESTAMPTZ_NS":
      return fc.bigInt(-I64_MAX + 1n, I64_MAX - 1n);
    case "INTERVAL":
      return fc.record({
        months: fc.integer({ min: -2147483648, max: 2147483647 }),
        days: fc.integer({ min: -2147483648, max: 2147483647 }),
        micros: fc.bigInt(I64_MIN + 1n, I64_MAX),
      });
    case "UUID":
      return fc.bigInt(0n, 2n ** 128n - 1n);
    case "BIT":
      return fc.string({ minLength: 1, maxLength: 70, unit: fc.constantFrom("0", "1") });
    case "GEOMETRY":
      return fc
        .tuple(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: -1000, max: 1000 }))
        .map(([x, y]) => `POINT(${x} ${y})`);
  }
}

/** Canonical text of a map key, for keeping generated keys unique. */
function keyText(raw: Raw): string {
  return typeof raw === "bigint" ? `${raw}n` : JSON.stringify(raw);
}

/** Values of `type`, NULL included at every level. */
export function valueArb(type: FuzzType): fc.Arbitrary<Raw> {
  return fc.option(nonNullArb(type), { nil: null, freq: 6 });
}

function nonNullArb(type: FuzzType): fc.Arbitrary<Raw> {
  switch (type.kind) {
    case "DECIMAL": {
      const bound = 10n ** BigInt(type.width) - 1n;
      return fc.bigInt(-bound, bound);
    }
    case "ENUM":
      return fc.constantFrom(...type.values);
    case "LIST":
      return fc.array(valueArb(type.child), { maxLength: 4 });
    case "ARRAY":
      return fc.array(valueArb(type.child), { minLength: type.size, maxLength: type.size });
    case "STRUCT":
      return fc
        .tuple(...type.fields.map(([, t]) => valueArb(t)))
        .map((values) => Object.fromEntries(type.fields.map(([name], i) => [name, values[i]])));
    case "MAP":
      return fc
        .uniqueArray(fc.tuple(nonNullArb(type.key), valueArb(type.value)), {
          maxLength: 4,
          selector: ([key]) => keyText(key),
        })
        .map((entries) => entries.map(([key, value]) => ({ key, value })));
    case "UNION":
      return fc.oneof(...type.members.map(([tag, t]) => valueArb(t).map((value) => ({ tag, value }))));
    case "VARIANT":
      return nonNullArb(type.inner);
    default:
      return scalarArb(type.kind);
  }
}

/** A table of 1 to 3 columns of random types and 1 to 3 rows. */
export function caseArb(depth = 3): fc.Arbitrary<FuzzCase> {
  return fc
    .array(typeArb(depth), { minLength: 1, maxLength: 3 })
    .chain((types) =>
      fc
        .array(fc.tuple(...types.map((t) => valueArb(t))), { minLength: 1, maxLength: 3 })
        .map((rows) => ({ types, rows: rows.map((row) => [...row]) })),
    );
}

/** Kinds whose vectors `staleAfterWrite` describes. */
const STALE_KINDS = new Set(["BLOB", "BIT", "BIGNUM", "GEOMETRY", "MAP", "ARRAY"]);

/**
 * True when `type` holds a kind that a DuckDBDataChunk cannot read back after
 * setRows() in `@duckdb/node-api`, the official package and ours alike.
 *
 * A vector object reads from the copy of the vector's memory that
 * `vector_get_data` returned when the object was built: the official binding
 * builds it with `Napi::Buffer::NewOrCopy` under
 * `NODE_API_NO_EXTERNAL_BUFFERS_ALLOWED`, so it is a copy, and ours matches.
 * The VARCHAR and LIST vectors answer getItem() from the values setItem()
 * stored, but the BLOB, BIT, BIGNUM, and GEOMETRY vectors, and the children of
 * MAP and ARRAY vectors, read that copy, which predates the write. A string in
 * it points wherever the uninitialized memory says. Both implementations then
 * read garbage or die: `BLOB` rows `[3 bytes], [2 bytes]`, `MAP(VARCHAR, INTEGER)`,
 * and `VARCHAR[2]` each end in SIGSEGV or SIGBUS on getRows().
 *
 * The same chunk appended with appendDataChunk(), and the same values written
 * by a function callback, reach DuckDB intact; only the direct read is skipped.
 */
export function staleAfterWrite(type: FuzzType): boolean {
  return kindsOf(type).some((kind) => STALE_KINDS.has(kind));
}

/** Every kind used in `type`, outermost first. */
export function kindsOf(type: FuzzType): string[] {
  switch (type.kind) {
    case "LIST":
    case "ARRAY":
      return [type.kind, ...kindsOf(type.child)];
    case "STRUCT":
    case "UNION":
      return [type.kind, ...(type.kind === "STRUCT" ? type.fields : type.members).flatMap(([, t]) => kindsOf(t))];
    case "MAP":
      return ["MAP", ...kindsOf(type.key), ...kindsOf(type.value)];
    case "VARIANT":
      return ["VARIANT", ...kindsOf(type.inner)];
    default:
      return [type.kind];
  }
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const quoteString = (text: string) => `'${text.replaceAll("'", "''")}'`;
const quoteIdent = (text: string) => `"${text.replaceAll('"', '""')}"`;

/** The SQL spelling of `type`. */
export function sqlType(type: FuzzType): string {
  switch (type.kind) {
    case "DECIMAL":
      return `DECIMAL(${type.width}, ${type.scale})`;
    case "ENUM":
      return `ENUM(${type.values.map(quoteString).join(", ")})`;
    case "LIST":
      return `${sqlType(type.child)}[]`;
    case "ARRAY":
      return `${sqlType(type.child)}[${type.size}]`;
    case "STRUCT":
      return `STRUCT(${type.fields.map(([name, t]) => `${quoteIdent(name)} ${sqlType(t)}`).join(", ")})`;
    case "MAP":
      return `MAP(${sqlType(type.key)}, ${sqlType(type.value)})`;
    case "UNION":
      return `UNION(${type.members.map(([name, t]) => `${quoteIdent(name)} ${sqlType(t)}`).join(", ")})`;
    default:
      return type.kind;
  }
}

/** A string literal that may hold NUL, which the SQL tokenizer does not accept inside a literal. */
function stringLiteral(text: string): string {
  if (!text.includes("\0")) return quoteString(text);
  return `(${text.split("\0").map(quoteString).join(" || chr(0) || ")})`;
}

const pad = (n: bigint | number, width: number) => String(n).padStart(width, "0");

/** `HH:MM:SS.<fraction>` for a time of day in units of 10^-digits seconds. */
function timeOfDay(ticks: bigint, digits: number): string {
  const perSecond = 10n ** BigInt(digits);
  const seconds = ticks / perSecond;
  return `${pad(seconds / 3600n, 2)}:${pad((seconds / 60n) % 60n, 2)}:${pad(seconds % 60n, 2)}.${pad(ticks % perSecond, digits)}`;
}

function offsetText(offset: number): string {
  const abs = Math.abs(offset);
  return `${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 3600), 2)}:${pad(Math.floor(abs / 60) % 60, 2)}:${pad(abs % 60, 2)}`;
}

function decimalText(value: bigint, scale: number): string {
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, "0");
  return scale === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function uuidText(value: bigint): string {
  const hex = value.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function numberText(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

/** A SQL expression of type `type` and value `raw`, built without any binding call. */
export function sqlLiteral(type: FuzzType, raw: Raw): string {
  return `CAST(${sqlExpression(type, raw)} AS ${sqlType(type)})`;
}

function sqlExpression(type: FuzzType, raw: Raw): string {
  if (raw === null) return "NULL";
  switch (type.kind) {
    case "BOOLEAN":
      return raw ? "true" : "false";
    case "FLOAT":
    case "DOUBLE":
      return quoteString(numberText(raw as number));
    case "VARCHAR":
    case "ENUM":
    case "GEOMETRY":
      return stringLiteral(raw as string);
    case "BLOB":
      return `from_hex('${Buffer.from(raw as Uint8Array).toString("hex")}')`;
    case "DATE": {
      const days = raw as number;
      if (Math.abs(days) === 2147483647) return days > 0 ? "'infinity'" : "'-infinity'";
      return `(DATE '1970-01-01' + ${days}::INTEGER)`;
    }
    case "TIME":
      return quoteString(timeOfDay(raw as bigint, 6));
    case "TIME_NS":
      return quoteString(timeOfDay(raw as bigint, 9));
    case "TIMETZ": {
      const { micros, offset } = raw as TimeTZRaw;
      return quoteString(`${timeOfDay(micros, 6)}${offsetText(offset)}`);
    }
    case "TIMESTAMP":
    case "TIMESTAMPTZ":
      return infinityOr(raw as bigint, (n) => `make_timestamp(${n}::BIGINT)`);
    case "TIMESTAMP_S":
      return infinityOr(raw as bigint, (n) => `make_timestamp(${n}::BIGINT * 1000000)`);
    case "TIMESTAMP_MS":
      return infinityOr(raw as bigint, (n) => `make_timestamp(${n}::BIGINT * 1000)`);
    case "TIMESTAMP_NS":
    case "TIMESTAMPTZ_NS":
      return `make_timestamp_ns(${raw}::BIGINT)`;
    case "INTERVAL": {
      const { months, days, micros } = raw as IntervalRaw;
      return `(to_months(${months}::INTEGER) + to_days(${days}::INTEGER) + to_microseconds(${micros}::BIGINT))`;
    }
    case "UUID":
      return quoteString(uuidText(raw as bigint));
    case "DECIMAL":
      return quoteString(decimalText(raw as bigint, type.scale));
    case "BIT":
      return quoteString(raw as string);
    case "LIST":
    case "ARRAY":
      return `[${(raw as Raw[]).map((item) => sqlLiteral(type.child, item)).join(", ")}]`;
    case "STRUCT": {
      const record = raw as Record<string, Raw>;
      return `{${type.fields.map(([name, t]) => `${quoteString(name)}: ${sqlLiteral(t, record[name] ?? null)}`).join(", ")}}`;
    }
    case "MAP": {
      const entries = raw as { key: Raw; value: Raw }[];
      const keys = entries.map((e) => sqlLiteral(type.key, e.key));
      const values = entries.map((e) => sqlLiteral(type.value, e.value));
      return `MAP(CAST([${keys.join(", ")}] AS ${sqlType(type.key)}[]), CAST([${values.join(", ")}] AS ${sqlType(type.value)}[]))`;
    }
    case "UNION": {
      const { tag, value } = raw as { tag: string; value: Raw };
      const member = type.members.find(([name]) => name === tag) as [string, FuzzType];
      return `union_value(${quoteIdent(tag)} := ${sqlLiteral(member[1], value)})`;
    }
    case "VARIANT":
      return sqlLiteral(type.inner, raw);
    default:
      // Integers of every width, BIGNUM included, cast from their decimal text.
      return quoteString(String(raw));
  }
}

function infinityOr(value: bigint, finite: (n: bigint) => string): string {
  if (value === I64_MAX) return "'infinity'";
  if (value === -I64_MAX) return "'-infinity'";
  return finite(value);
}

// ---------------------------------------------------------------------------
// @duckdb/node-api values and types
// ---------------------------------------------------------------------------

/** The `@duckdb/node-api` type object for `type`, from `api`. */
export function apiType(api: Api, type: FuzzType): DuckDBType {
  switch (type.kind) {
    case "DECIMAL":
      return api.DECIMAL(type.width, type.scale);
    case "ENUM":
      return api.ENUM(type.values);
    case "LIST":
      return api.LIST(apiType(api, type.child));
    case "ARRAY":
      return api.ARRAY(apiType(api, type.child), type.size);
    case "STRUCT":
      return api.STRUCT(Object.fromEntries(type.fields.map(([name, t]) => [name, apiType(api, t)])));
    case "MAP":
      return api.MAP(apiType(api, type.key), apiType(api, type.value));
    case "UNION":
      return api.UNION(Object.fromEntries(type.members.map(([name, t]) => [name, apiType(api, t)])));
    case "VARIANT":
      return api.VARIANT;
    default:
      return api[type.kind];
  }
}

/** The `@duckdb/node-api` value for `raw`, built with `api`'s constructor functions. */
export function apiValue(api: Api, type: FuzzType, raw: Raw): DuckDBValue {
  if (raw === null) return null;
  switch (type.kind) {
    case "BLOB":
      return api.blobValue(raw as Uint8Array);
    case "DATE":
      return api.dateValue(raw as number);
    case "TIME":
      return api.timeValue(raw as bigint);
    case "TIME_NS":
      return api.timeNSValue(raw as bigint);
    case "TIMETZ": {
      const { micros, offset } = raw as TimeTZRaw;
      return api.timeTZValue(micros, offset);
    }
    case "TIMESTAMP":
      return api.timestampValue(raw as bigint);
    case "TIMESTAMPTZ":
      return api.timestampTZValue(raw as bigint);
    case "TIMESTAMP_S":
      return api.timestampSecondsValue(raw as bigint);
    case "TIMESTAMP_MS":
      return api.timestampMillisValue(raw as bigint);
    case "TIMESTAMP_NS":
      return api.timestampNanosValue(raw as bigint);
    case "TIMESTAMPTZ_NS":
      return api.timestampTZNanosValue(raw as bigint);
    case "INTERVAL": {
      const { months, days, micros } = raw as IntervalRaw;
      return api.intervalValue(months, days, micros);
    }
    case "UUID":
      return api.uuidValue(raw as bigint);
    case "BIT":
      return api.bitValue(raw as string);
    case "GEOMETRY":
      return api.geometryValue(raw as string);
    case "DECIMAL":
      return api.decimalValue(raw as bigint, type.width, type.scale);
    case "LIST":
      return api.listValue((raw as Raw[]).map((item) => apiValue(api, type.child, item)));
    case "ARRAY":
      return api.arrayValue((raw as Raw[]).map((item) => apiValue(api, type.child, item)));
    case "STRUCT": {
      const record = raw as Record<string, Raw>;
      return api.structValue(
        Object.fromEntries(type.fields.map(([name, t]) => [name, apiValue(api, t, record[name] ?? null)])),
      );
    }
    case "MAP":
      return api.mapValue(
        (raw as { key: Raw; value: Raw }[]).map((e) => ({
          key: apiValue(api, type.key, e.key),
          value: apiValue(api, type.value, e.value),
        })),
      );
    case "UNION": {
      const { tag, value } = raw as { tag: string; value: Raw };
      const member = type.members.find(([name]) => name === tag) as [string, FuzzType];
      return api.unionValue(tag, apiValue(api, member[1], value));
    }
    case "VARIANT":
      return api.variantValue(apiValue(api, type.inner, raw), apiType(api, type.inner));
    default:
      // BOOLEAN, the integers, BIGNUM, FLOAT, DOUBLE, VARCHAR, and ENUM are JS primitives.
      return raw as DuckDBValue;
  }
}
