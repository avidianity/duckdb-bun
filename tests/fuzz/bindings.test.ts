// Raw binding fuzz: random sequences of calls into the `@duckdb/node-bindings`
// contract, valid and invalid alike, run against the official N-API binding and
// against ours (src/bindings/). Arguments are well-formed values, values of the
// wrong JavaScript type, null and undefined, handles of the wrong kind, numbers
// out of range, and indexes past the end. Each call's result or error must match:
// the same value, or the same error class and message. A crash of either process
// is a failure; FUZZ_TRACE (tests/fuzz/config.ts) names the sequence behind it.
//
// Left out on purpose: the calls that are memory-unsafe by contract, because
// their arguments are trusted byte counts, offsets, or row indexes that neither
// binding checks (vector_get_data, vector_get_validity, get_data_from_pointer,
// copy_data_to_vector*, validity_set_*, vector_assign_string_element*,
// list_vector_*, struct_vector_get_child, array_vector_get_child,
// vector_reference_value, create_vector); and everything that takes a callback,
// which tests/fuzz/values.test.ts and the official suites cover.
//
// C++ exceptions: many libduckdb C API functions throw a C++ exception on bad
// input, such as to_date() with month 0, to_timestamp() past the timestamp range,
// and get_bignum() or get_blob() on a value that does not cast. Bun's N-API turns
// the exception into "A native exception was thrown" for the official binding;
// ours catches it in the shim (native/cpp/boundary.hpp) and throws DuckDB's
// message, such as "Conversion Error: Date out of range: 2025-0-1". Where the
// official binding reports a native exception, ours must throw an Error with a
// DuckDB message, and both count as equal.
//
// Allowed differences, from the runtimes rather than the code:
// - Given null or undefined where it reads an object or a handle, the official
//   binding under Bun throws Bun's own TypeError, "null is not an object
//   (evaluating '...')", which quotes the caller's source. Ours throws N-API's
//   "An object was expected" or the handle's "Invalid <kind> argument".
//
// Official crash, not mirrored: get_table_names() for SQL that does not parse,
// is empty, has parameters, or has more than one statement, and create_decimal()
// with a width over 38 or a scale over the width, wrap a missing value, and the
// official scalar getters then die with SIGSEGV; ours throws "Invalid value
// argument". Here get_table_names() gets only one parameterless SELECT, even
// among its wrong arguments, and create_decimal() a valid width and scale;
// tests/runtime/values.test.ts covers the rest.
//
// Official crash, not mirrored: create_bit() passes any bytes on, and DuckDB's
// BIT to VARCHAR cast writes past its buffer when the padding byte is 8 or more
// and throws a C++ exception when it exceeds the bit count, so get_varchar() on
// such a value dies with SIGSEGV or throws. Ours refuses it in create_bit().
// Here create_bit() gets valid bit strings only; tests/runtime/values.test.ts
// covers the rest.
//
// Official bug, not mirrored: get_bignum() on a value that is not a BIGNUM
// returns a wrong number from the official binding (0n for INTEGER 7, 5n for
// HUGEINT 2^70 + 5), where ours returns the cast value. Successful get_bignum()
// results are not compared; tests/fuzz/values.test.ts compares BIGNUM values.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import fc from "fast-check";
import ours from "../../src/bindings/index.ts";
import { assertRealOfficialBinding } from "../official-binding.ts";
import { check, RUNS, trace } from "./config.ts";

assertRealOfficialBinding();
type Bindings = typeof ours;
const official = createRequire(Bun.resolveSync("@duckdb/node-api", import.meta.dir))(
  "@duckdb/node-bindings",
) as Bindings;
const IMPLS = { official, ours } as const;
type Impl = keyof typeof IMPLS;

// --- argument kinds -------------------------------------------------------------------

/** Pools of handles a sequence builds up; an argument names a pool and an entry. */
const POOLS = ["type", "value", "chunk", "vector", "config", "connection", "prepared", "result", "appender"] as const;
type Pool = (typeof POOLS)[number];

/** What a contract parameter takes. A pool name takes a handle from that pool. */
type Param =
  | Pool
  | "index"
  | "int8"
  | "uint8"
  | "int16"
  | "uint16"
  | "int32"
  | "uint32"
  | "double"
  | "int64"
  | "uint64"
  | "int128"
  | "uint128"
  | "string"
  | "name"
  | "sql"
  | "parsedSql"
  | "bytes"
  | "bitBytes"
  | "boolean"
  | "typeId"
  | "types"
  | "names"
  | "values"
  | "date"
  | "time"
  | "timeNs"
  | "timeTz"
  | "timestamp"
  | "timestampS"
  | "timestampMs"
  | "timestampNs"
  | "interval"
  | "decimal"
  | "dateParts"
  | "timeParts"
  | "timestampParts"
  | "width"
  | "schema";

/** An argument as generated: plain data, or a reference to a pool entry resolved per implementation. */
type Recipe = { data: unknown } | { pool: Pool; pick: number } | { list: Pool; picks: number[] };

const handle = (pool: Pool) => fc.nat(7).map((pick): Recipe => ({ pool, pick }));
const data = <T>(arb: fc.Arbitrary<T>) => arb.map((value): Recipe => ({ data: value }));

/** Integers inside [min, max], its edges, and the numbers just past them. */
const integer = (min: number, max: number) =>
  fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min, max }) },
    { weight: 2, arbitrary: fc.constantFrom(min, max, 0) },
    { weight: 1, arbitrary: fc.constantFrom(min - 1, max + 1, 1.5, -0, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53) },
  );
const bigint = (min: bigint, max: bigint) =>
  fc.oneof(
    { weight: 6, arbitrary: fc.bigInt({ min, max }) },
    { weight: 2, arbitrary: fc.constantFrom(min, max, 0n) },
    { weight: 1, arbitrary: fc.constantFrom(min - 1n, max + 1n) },
  );
const I64 = [-(2n ** 63n), 2n ** 63n - 1n] as const;
const U64 = [0n, 2n ** 64n - 1n] as const;
const I128 = [-(2n ** 127n), 2n ** 127n - 1n] as const;
const U128 = [0n, 2n ** 128n - 1n] as const;

const strings = fc.oneof(
  fc.constantFrom("", "x", "a\u0000b", "é😀", "main", "t", "i", "s", "nope", "threads", "memory_limit", "1GB", "4"),
  fc.string({ maxLength: 20, unit: "grapheme" }),
);
const SQL = [
  "SELECT 1 AS a",
  "SELECT $1::INTEGER AS a, $2::VARCHAR AS b",
  "SELECT ?::DATE AS d",
  "SELECT $name::BIGINT AS n",
  "SELECT * FROM t",
  "INSERT INTO t VALUES ($1, $2)",
  "SELECT [1, 2] AS l, {'a': 1} AS s, 'x'::BLOB AS b, 1.5::DECIMAL(4, 1) AS d",
  "SELECT range AS r FROM range(3000)",
  "SELEC 1",
  "",
  "SELECT 1; SELECT 2",
];
const object = <T>(fields: { [K in keyof T]: fc.Arbitrary<T[K]> }) => fc.record(fields);

const VALID: Record<Param, fc.Arbitrary<Recipe>> = {
  ...(Object.fromEntries(POOLS.map((pool) => [pool, handle(pool)])) as Record<Pool, fc.Arbitrary<Recipe>>),
  index: data(fc.oneof({ weight: 6, arbitrary: fc.nat(4) }, { weight: 1, arbitrary: integer(0, 2 ** 32) })),
  int8: data(integer(-128, 127)),
  uint8: data(integer(0, 255)),
  int16: data(integer(-32768, 32767)),
  uint16: data(integer(0, 65535)),
  int32: data(integer(-(2 ** 31), 2 ** 31 - 1)),
  uint32: data(integer(0, 2 ** 32 - 1)),
  double: data(fc.double()),
  int64: data(bigint(...I64)),
  uint64: data(bigint(...U64)),
  int128: data(bigint(...I128)),
  uint128: data(bigint(...U128)),
  string: data(strings),
  name: data(fc.constantFrom("a", "b", "x", "y", "é", "A")),
  sql: data(fc.constantFrom(...SQL)),
  parsedSql: data(fc.constantFrom(...SQL.filter((sql) => /^SELECT [^$?;]*$/.test(sql)))),
  bytes: data(fc.uint8Array({ maxLength: 20 })),
  // A valid bit string only: see the official crash at the top of the file.
  bitBytes: data(
    fc.oneof(
      fc.constant(new Uint8Array([0])),
      fc
        .tuple(fc.integer({ min: 0, max: 7 }), fc.uint8Array({ minLength: 1, maxLength: 19 }))
        .map(([padding, bits]) => new Uint8Array([padding, ...bits])),
    ),
  ),
  boolean: data(fc.boolean()),
  typeId: data(fc.oneof(fc.integer({ min: 0, max: 42 }), fc.constantFrom(-1, 43, 1000))),
  types: fc.array(fc.nat(7), { maxLength: 3 }).map((picks): Recipe => ({ list: "type", picks })),
  names: data(fc.array(fc.constantFrom("a", "b", "c", "A", ""), { maxLength: 3 })),
  values: fc.array(fc.nat(7), { maxLength: 3 }).map((picks): Recipe => ({ list: "value", picks })),
  date: data(object({ days: integer(-(2 ** 31), 2 ** 31 - 1) })),
  time: data(object({ micros: bigint(0n, 86_400_000_000n) })),
  timeNs: data(object({ nanos: bigint(0n, 86_400_000_000_000n) })),
  timeTz: data(object({ bits: bigint(...U64) })),
  timestamp: data(object({ micros: bigint(...I64) })),
  timestampS: data(object({ seconds: bigint(...I64) })),
  timestampMs: data(object({ millis: bigint(...I64) })),
  timestampNs: data(object({ nanos: bigint(...I64) })),
  interval: data(
    object({
      months: integer(-(2 ** 31), 2 ** 31 - 1),
      days: integer(-(2 ** 31), 2 ** 31 - 1),
      micros: bigint(...I64),
    }),
  ),
  // A valid width and scale only: see the official crash at the top of the file.
  decimal: data(
    fc
      .integer({ min: 1, max: 38 })
      .chain((width) =>
        object({ width: fc.constant(width), scale: fc.integer({ min: 0, max: width }), value: bigint(...I128) }),
      ),
  ),
  dateParts: data(object({ year: integer(-300000, 300000), month: integer(1, 12), day: integer(1, 31) })),
  timeParts: data(
    object({ hour: integer(0, 24), min: integer(0, 59), sec: integer(0, 59), micros: integer(0, 999999) }),
  ),
  timestampParts: data(
    object({
      date: object({ year: integer(-300000, 300000), month: integer(1, 12), day: integer(1, 31) }),
      time: object({ hour: integer(0, 24), min: integer(0, 59), sec: integer(0, 59), micros: integer(0, 999999) }),
    }),
  ),
  width: data(integer(0, 40)),
  schema: data(fc.constantFrom(null, "main", "nope")),
};

const JUNK_DATA = [null, undefined, 0, -1, 1.5, Number.NaN, "x", "", 1n, true, {}, [], [1]];

/** Values of the wrong JavaScript type, and handles from the wrong pool. */
function junk(param: Param): fc.Arbitrary<Recipe> {
  // A string for get_table_names() would be SQL that does not parse: see the
  // official crash at the top of the file.
  const values = param === "parsedSql" ? JUNK_DATA.filter((value) => typeof value !== "string") : JUNK_DATA;
  return fc.oneof(data(fc.constantFrom(...values)), fc.constantFrom(...POOLS).chain(handle));
}

const argument = (param: Param) =>
  fc.oneof({ weight: 12, arbitrary: VALID[param] }, { weight: 1, arbitrary: junk(param) });

// --- the calls -----------------------------------------------------------------------------

/** A contract function, its parameters, and the pool its result joins, if it returns a handle. */
type Operation = [name: keyof Bindings, params: Param[], returns?: Pool];

const OPERATIONS: Operation[] = [
  // logical types
  ["create_logical_type", ["typeId"], "type"],
  ["create_list_type", ["type"], "type"],
  ["create_array_type", ["type", "index"], "type"],
  ["create_map_type", ["type", "type"], "type"],
  ["create_struct_type", ["types", "names"], "type"],
  ["create_union_type", ["types", "names"], "type"],
  ["create_enum_type", ["names"], "type"],
  ["create_decimal_type", ["width", "width"], "type"],
  ["get_type_id", ["type"]],
  ["logical_type_get_alias", ["type"]],
  ["logical_type_set_alias", ["type", "string"]],
  ["decimal_width", ["type"]],
  ["decimal_scale", ["type"]],
  ["decimal_internal_type", ["type"]],
  ["enum_internal_type", ["type"]],
  ["enum_dictionary_size", ["type"]],
  ["enum_dictionary_value", ["type", "index"]],
  ["list_type_child_type", ["type"], "type"],
  ["array_type_child_type", ["type"], "type"],
  ["array_type_array_size", ["type"]],
  ["map_type_key_type", ["type"], "type"],
  ["map_type_value_type", ["type"], "type"],
  ["struct_type_child_count", ["type"]],
  ["struct_type_child_name", ["type", "index"]],
  ["struct_type_child_type", ["type", "index"], "type"],
  ["union_type_member_count", ["type"]],
  ["union_type_member_name", ["type", "index"]],
  ["union_type_member_type", ["type", "index"], "type"],
  // values
  ["create_varchar", ["string"], "value"],
  ["create_bool", ["boolean"], "value"],
  ["create_int8", ["int8"], "value"],
  ["create_uint8", ["uint8"], "value"],
  ["create_int16", ["int16"], "value"],
  ["create_uint16", ["uint16"], "value"],
  ["create_int32", ["int32"], "value"],
  ["create_uint32", ["uint32"], "value"],
  ["create_int64", ["int64"], "value"],
  ["create_uint64", ["uint64"], "value"],
  ["create_hugeint", ["int128"], "value"],
  ["create_uhugeint", ["uint128"], "value"],
  ["create_bignum", ["int128"], "value"],
  ["create_decimal", ["decimal"], "value"],
  ["create_float", ["double"], "value"],
  ["create_double", ["double"], "value"],
  ["create_date", ["date"], "value"],
  ["create_time", ["time"], "value"],
  ["create_time_ns", ["timeNs"], "value"],
  ["create_time_tz_value", ["timeTz"], "value"],
  ["create_timestamp", ["timestamp"], "value"],
  ["create_timestamp_tz", ["timestamp"], "value"],
  ["create_timestamp_tz_ns", ["timestampNs"], "value"],
  ["create_timestamp_s", ["timestampS"], "value"],
  ["create_timestamp_ms", ["timestampMs"], "value"],
  ["create_timestamp_ns", ["timestampNs"], "value"],
  ["create_interval", ["interval"], "value"],
  ["create_blob", ["bytes"], "value"],
  ["create_bit", ["bitBytes"], "value"],
  ["create_uuid", ["uint128"], "value"],
  ["create_null_value", [], "value"],
  ["create_struct_value", ["type", "values"], "value"],
  ["create_list_value", ["type", "values"], "value"],
  ["create_array_value", ["type", "values"], "value"],
  ["create_map_value", ["type", "values", "values"], "value"],
  ["create_union_value", ["type", "index", "value"], "value"],
  ["create_enum_value", ["type", "index"], "value"],
  ["get_bool", ["value"]],
  ["get_int8", ["value"]],
  ["get_uint8", ["value"]],
  ["get_int16", ["value"]],
  ["get_uint16", ["value"]],
  ["get_int32", ["value"]],
  ["get_uint32", ["value"]],
  ["get_int64", ["value"]],
  ["get_uint64", ["value"]],
  ["get_hugeint", ["value"]],
  ["get_uhugeint", ["value"]],
  ["get_bignum", ["value"]],
  ["get_decimal", ["value"]],
  ["get_float", ["value"]],
  ["get_double", ["value"]],
  ["get_date", ["value"]],
  ["get_time", ["value"]],
  ["get_time_ns", ["value"]],
  ["get_time_tz", ["value"]],
  ["get_timestamp", ["value"]],
  ["get_timestamp_tz", ["value"]],
  ["get_timestamp_tz_ns", ["value"]],
  ["get_timestamp_s", ["value"]],
  ["get_timestamp_ms", ["value"]],
  ["get_timestamp_ns", ["value"]],
  ["get_interval", ["value"]],
  ["get_blob", ["value"]],
  ["get_bit", ["value"]],
  ["get_uuid", ["value"]],
  ["get_varchar", ["value"]],
  ["get_value_type", ["value"], "type"],
  ["is_null_value", ["value"]],
  ["get_map_size", ["value"]],
  ["get_map_key", ["value", "index"], "value"],
  ["get_map_value", ["value", "index"], "value"],
  ["get_list_size", ["value"]],
  ["get_list_child", ["value", "index"], "value"],
  ["get_enum_value", ["value"]],
  ["get_struct_child", ["value", "index"], "value"],
  // conversions
  ["from_date", ["date"]],
  ["to_date", ["dateParts"]],
  ["is_finite_date", ["date"]],
  ["from_time", ["time"]],
  ["create_time_tz", ["int64", "int32"]],
  ["from_time_tz", ["timeTz"]],
  ["to_time", ["timeParts"]],
  ["from_timestamp", ["timestamp"]],
  ["to_timestamp", ["timestampParts"]],
  ["is_finite_timestamp", ["timestamp"]],
  ["is_finite_timestamp_s", ["timestampS"]],
  ["is_finite_timestamp_ms", ["timestampMs"]],
  ["is_finite_timestamp_ns", ["timestampNs"]],
  ["hugeint_to_double", ["int128"]],
  ["double_to_hugeint", ["double"]],
  ["uhugeint_to_double", ["uint128"]],
  ["double_to_uhugeint", ["double"]],
  ["double_to_decimal", ["double", "width", "width"]],
  ["decimal_to_double", ["decimal"]],
  // data chunks and vectors
  ["create_data_chunk", ["types"], "chunk"],
  ["data_chunk_get_column_count", ["chunk"]],
  ["data_chunk_get_vector", ["chunk", "index"], "vector"],
  ["data_chunk_get_size", ["chunk"]],
  ["data_chunk_reset", ["chunk"]],
  ["vector_get_column_type", ["vector"], "type"],
  // configuration
  ["create_config", [], "config"],
  ["config_count", []],
  ["get_config_flag", ["index"]],
  ["set_config", ["config", "string", "string"]],
  // connections, prepared statements, and results
  ["query", ["connection", "sql"], "result"],
  ["prepare", ["connection", "sql"], "prepared"],
  ["query_progress", ["connection"]],
  // Only a parameterless SELECT: see the official crash at the top of the file.
  ["get_table_names", ["connection", "parsedSql", "boolean"], "value"],
  ["nparams", ["prepared"]],
  ["parameter_name", ["prepared", "index"]],
  ["param_type", ["prepared", "index"]],
  ["param_logical_type", ["prepared", "index"], "type"],
  ["clear_bindings", ["prepared"]],
  ["prepared_statement_type", ["prepared"]],
  ["prepared_statement_column_count", ["prepared"]],
  ["prepared_statement_column_name", ["prepared", "index"]],
  ["prepared_statement_column_logical_type", ["prepared", "index"], "type"],
  ["prepared_statement_column_type", ["prepared", "index"]],
  ["bind_value", ["prepared", "index", "value"]],
  ["bind_parameter_index", ["prepared", "name"]],
  ["bind_boolean", ["prepared", "index", "boolean"]],
  ["bind_int8", ["prepared", "index", "int8"]],
  ["bind_int16", ["prepared", "index", "int16"]],
  ["bind_int32", ["prepared", "index", "int32"]],
  ["bind_int64", ["prepared", "index", "int64"]],
  ["bind_hugeint", ["prepared", "index", "int128"]],
  ["bind_uhugeint", ["prepared", "index", "uint128"]],
  ["bind_decimal", ["prepared", "index", "decimal"]],
  ["bind_uint8", ["prepared", "index", "uint8"]],
  ["bind_uint16", ["prepared", "index", "uint16"]],
  ["bind_uint32", ["prepared", "index", "uint32"]],
  ["bind_uint64", ["prepared", "index", "uint64"]],
  ["bind_float", ["prepared", "index", "double"]],
  ["bind_double", ["prepared", "index", "double"]],
  ["bind_date", ["prepared", "index", "date"]],
  ["bind_time", ["prepared", "index", "time"]],
  ["bind_timestamp", ["prepared", "index", "timestamp"]],
  ["bind_timestamp_tz", ["prepared", "index", "timestamp"]],
  ["bind_interval", ["prepared", "index", "interval"]],
  ["bind_varchar", ["prepared", "index", "string"]],
  ["bind_blob", ["prepared", "index", "bytes"]],
  ["bind_null", ["prepared", "index"]],
  ["execute_prepared", ["prepared"], "result"],
  ["execute_prepared_streaming", ["prepared"], "result"],
  ["destroy_prepare_sync", ["prepared"]],
  ["column_name", ["result", "index"]],
  ["column_type", ["result", "index"]],
  ["column_logical_type", ["result", "index"], "type"],
  ["column_count", ["result"]],
  ["rows_changed", ["result"]],
  ["result_statement_type", ["result"]],
  ["result_return_type", ["result"]],
  ["result_is_streaming", ["result"]],
  ["fetch_chunk", ["result"], "chunk"],
  ["destroy_result_sync", ["result"]],
  // appenders
  ["appender_create", ["connection", "schema", "name"], "appender"],
  ["appender_column_count", ["appender"]],
  ["appender_column_type", ["appender", "index"], "type"],
  ["appender_end_row", ["appender"]],
  ["appender_flush_sync", ["appender"]],
  ["appender_clear", ["appender"]],
  ["appender_close_sync", ["appender"]],
  ["append_default", ["appender"]],
  ["append_null", ["appender"]],
  ["append_bool", ["appender", "boolean"]],
  ["append_int32", ["appender", "int32"]],
  ["append_int64", ["appender", "int64"]],
  ["append_uint8", ["appender", "uint8"]],
  ["append_double", ["appender", "double"]],
  ["append_date", ["appender", "date"]],
  ["append_interval", ["appender", "interval"]],
  ["append_varchar", ["appender", "string"]],
  ["append_blob", ["appender", "bytes"]],
  ["append_value", ["appender", "value"]],
  ["append_data_chunk", ["appender", "chunk"]],
];

type Call = [operation: Operation, recipes: Recipe[]];

const callArb: fc.Arbitrary<Call> = fc.oneof(
  ...OPERATIONS.map((operation) =>
    fc.tuple(fc.constant(operation), fc.tuple(...operation[1].map(argument)) as fc.Arbitrary<Recipe[]>),
  ),
);
const sequenceArb = fc.array(callArb, { minLength: 1, maxLength: 25 });

// --- running a sequence -----------------------------------------------------------------

type World = Record<Pool, unknown[]>;

const shared = new Map<Impl, { database: unknown; connection: unknown }>();

/**
 * A new connection for each sequence, so a result a sequence leaves open, which
 * blocks new queries on its connection until the garbage collector frees it,
 * cannot reach the next sequence on one side only.
 */
async function sequenceConnection(impl: Impl): Promise<unknown> {
  const { database } = shared.get(impl) as { database: unknown };
  return IMPLS[impl].connect(database as never);
}

beforeAll(async () => {
  for (const impl of Object.keys(IMPLS) as Impl[]) {
    const duckdb = IMPLS[impl];
    const database = await duckdb.open(":memory:");
    const connection = await duckdb.connect(database);
    await duckdb.query(connection, "CREATE TABLE t (i INTEGER, s VARCHAR)");
    shared.set(impl, { database, connection });
  }
});

afterAll(() => {
  for (const impl of Object.keys(IMPLS) as Impl[]) {
    const { database, connection } = shared.get(impl) as { database: unknown; connection: unknown };
    IMPLS[impl].disconnect_sync(connection as never);
    IMPLS[impl].close_sync(database as never);
  }
});

/** The handles every sequence starts from, built the same way on both sides. */
function newWorld(duckdb: Bindings, connection: unknown): World {
  const T = duckdb.Type;
  const type = (id: number) => duckdb.create_logical_type(id);
  const integer = type(T.INTEGER);
  const varchar = type(T.VARCHAR);
  return {
    type: [
      integer,
      varchar,
      duckdb.create_list_type(integer),
      duckdb.create_struct_type([integer, varchar], ["a", "b"]),
      duckdb.create_decimal_type(18, 3),
      duckdb.create_enum_type(["x", "y"]),
      duckdb.create_map_type(varchar, integer),
      duckdb.create_union_type([integer, varchar], ["n", "s"]),
      duckdb.create_array_type(integer, 2),
    ],
    value: [duckdb.create_int32(7), duckdb.create_varchar("v"), duckdb.create_null_value()],
    chunk: [],
    vector: [],
    config: [],
    connection: [connection],
    prepared: [],
    result: [],
    appender: [],
  };
}

function resolve(world: World, recipe: Recipe): unknown {
  if ("data" in recipe) return recipe.data;
  if ("pool" in recipe) {
    const pool = world[recipe.pool];
    return pool.length === 0 ? null : pool[recipe.pick % pool.length];
  }
  const pool = world[recipe.list];
  return pool.length === 0 ? [] : recipe.picks.map((pick) => pool[pick % pool.length]);
}

/** Plain, comparable data: handles become their pool's name, bigints and bytes become text. */
function plain(value: unknown, returns: Pool | undefined): unknown {
  if (value === undefined) return "<undefined>";
  if (value === null) return null;
  if (returns !== undefined) return `<${returns}>`;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : Number.isNaN(value) ? "NaN" : value;
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  if (Array.isArray(value)) return value.map((item) => plain(item, undefined));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item, undefined)]));
  }
  return value;
}

const BUN_NULL_OBJECT = /^(null|undefined) is not an object \(evaluating '.*'\)$/s;
const OURS_NULL_ARGUMENT = /^(An object was expected|Invalid [a-z ]+ argument)$/;

type Outcome = { ok: unknown } | { error: { class: string; message: string } };

/** What Bun's N-API reports for a C++ exception; see "C++ exceptions" at the top of the file. */
const NATIVE_EXCEPTION = "A native exception was thrown";
/** DuckDB's message for an error: its type's display name, if any, then "Error: ". */
const DUCKDB_MESSAGE = /^([A-Za-z][A-Za-z -]*[A-Za-z] )?Error: /;

/** Runs `sequence` on `impl`. */
async function run(impl: Impl, sequence: Call[]): Promise<Outcome[]> {
  const duckdb = IMPLS[impl];
  const world = newWorld(duckdb, await sequenceConnection(impl));
  const outcomes: Outcome[] = [];
  for (const [step, [[name, , returns], recipes]] of sequence.entries()) {
    trace(`${impl}, call ${step}: ${name}`, sequence);
    const args = recipes.map((recipe) => resolve(world, recipe));
    try {
      const result = await (duckdb[name] as (...args: unknown[]) => unknown)(...args);
      if (returns !== undefined && result !== null && result !== undefined) world[returns].push(result);
      outcomes.push({ ok: plain(result, returns) });
    } catch (error) {
      const { name: errorClass, message } =
        error instanceof Error ? error : { name: typeof error, message: String(error) };
      outcomes.push({ error: { class: error instanceof Error ? error.constructor.name : errorClass, message } });
    }
  }
  return outcomes;
}

/** Applies the allowed differences listed at the top of the file. */
function reconcile(sequence: Call[], official: Outcome[], ours: Outcome[]): void {
  for (let i = 0; i < Math.min(official.length, ours.length); i++) {
    const [a, b] = [official[i], ours[i]];
    if (
      "error" in a &&
      "error" in b &&
      a.error.message === NATIVE_EXCEPTION &&
      b.error.class === "Error" &&
      DUCKDB_MESSAGE.test(b.error.message)
    ) {
      official[i] = ours[i] = { error: { class: "allowed", message: "a C++ exception" } };
      tally.nativeExceptions += 1;
    }
    if (sequence[i][0][0] === "get_bignum" && "ok" in a && "ok" in b) {
      official[i] = ours[i] = { ok: "<not compared>" };
    }
    if (
      "error" in a &&
      "error" in b &&
      BUN_NULL_OBJECT.test(a.error.message) &&
      OURS_NULL_ARGUMENT.test(b.error.message)
    ) {
      official[i] = ours[i] = {
        error: { class: "allowed", message: "null or undefined where an object was expected" },
      };
    }
  }
}

const tally = { calls: 0, ok: 0, nativeExceptions: 0 };

describe("raw binding parity, fuzzed", () => {
  test(
    "random call sequences give the same results and errors",
    async () => {
      tally.calls = 0;
      tally.ok = 0;
      tally.nativeExceptions = 0;
      await check(
        "random call sequences give the same results and errors",
        fc.asyncProperty(sequenceArb, async (sequence) => {
          const officialOutcomes = await run("official", sequence);
          const oursOutcomes = await run("ours", sequence);
          reconcile(sequence, officialOutcomes, oursOutcomes);
          tally.calls += sequence.length;
          tally.ok += officialOutcomes.filter((outcome) => "ok" in outcome).length;
          const named = (outcomes: Outcome[]) =>
            outcomes.map((outcome, i) => ({ call: sequence[i][0][0], ...outcome }));
          expect(named(oursOutcomes)).toEqual(named(officialOutcomes));
        }),
        5,
      );
      console.log(
        `raw bindings: ${tally.calls} calls, ${tally.ok} without an error, ${tally.nativeExceptions} C++ exceptions caught`,
      );
      // Errors are compared like results, so the test also requires enough calls to succeed.
      expect(tally.ok).toBeGreaterThanOrEqual(Math.floor(tally.calls * 0.3));
    },
    Math.max(60_000, RUNS * 5 * 1_000),
  );
});
