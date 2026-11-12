// Prepared statement parity: every bind* method, binding by index and by name,
// bind() with and without types, the statement metadata, and run() with values.
import type { DuckDBMaterializedResult, DuckDBPreparedStatement, DuckDBResultReader } from "@duckdb/node-api";
import { type Api, capture, parityFor, withConnection } from "./harness.ts";

const parity = parityFor(import.meta.path);

function readBack(reader: DuckDBResultReader) {
  return {
    types: reader.columnTypes().map(String),
    rows: reader.getRows(),
    rowsJson: reader.getRowsJson(),
  };
}

/** Prepares `sql`, binds with `bind`, runs, and returns the bound parameter types and the rows. */
function bound(sql: string, bind: (prepared: DuckDBPreparedStatement, api: Api) => void) {
  return (api: Api) =>
    withConnection(api, async (connection) => {
      const prepared = await connection.prepare(sql);
      bind(prepared, api);
      return readBack(await prepared.runAndReadAll());
    });
}

const BIND_CASES: [name: string, sql: string, bind: (prepared: DuckDBPreparedStatement, api: Api) => void][] = [
  ["bindBoolean", "SELECT $1 AS v", (p) => p.bindBoolean(1, true)],
  ["bindTinyInt", "SELECT $1 AS v", (p) => p.bindTinyInt(1, -128)],
  ["bindSmallInt", "SELECT $1 AS v", (p) => p.bindSmallInt(1, 32767)],
  ["bindInteger", "SELECT $1 AS v", (p) => p.bindInteger(1, -2147483648)],
  ["bindBigInt", "SELECT $1 AS v", (p) => p.bindBigInt(1, 9223372036854775807n)],
  ["bindHugeInt", "SELECT $1 AS v", (p) => p.bindHugeInt(1, -170141183460469231731687303715884105728n)],
  ["bindUTinyInt", "SELECT $1 AS v", (p) => p.bindUTinyInt(1, 255)],
  ["bindUSmallInt", "SELECT $1 AS v", (p) => p.bindUSmallInt(1, 65535)],
  ["bindUInteger", "SELECT $1 AS v", (p) => p.bindUInteger(1, 4294967295)],
  ["bindUBigInt", "SELECT $1 AS v", (p) => p.bindUBigInt(1, 18446744073709551615n)],
  ["bindUHugeInt", "SELECT $1 AS v", (p) => p.bindUHugeInt(1, 340282366920938463463374607431768211455n)],
  ["bindBigNum", "SELECT $1 AS v", (p) => p.bindBigNum(1, -123456789012345678901234567890n)],
  ["bindDecimal", "SELECT $1 AS v", (p, api) => p.bindDecimal(1, api.decimalValue(123456789012345678n, 18, 3))],
  [
    "bindDecimal into a DECIMAL(18,3) cast",
    "SELECT $1::DECIMAL(18,3) AS v",
    (p, api) => p.bindDecimal(1, api.decimalValue(5n, 4, 1)),
  ],
  ["bindDecimal wide", "SELECT $1 AS v", (p, api) => p.bindDecimal(1, api.decimalValue(10n ** 37n + 7n, 38, 10))],
  ["bindFloat", "SELECT $1 AS v", (p) => p.bindFloat(1, 1.5)],
  ["bindDouble", "SELECT $1 AS v", (p) => p.bindDouble(1, Math.PI)],
  ["bindDouble NaN", "SELECT $1 AS v", (p) => p.bindDouble(1, Number.NaN)],
  ["bindDate", "SELECT $1 AS v", (p, api) => p.bindDate(1, api.dateValue({ year: 2026, month: 7, day: 12 }))],
  ["bindTime", "SELECT $1 AS v", (p, api) => p.bindTime(1, api.timeValue(49_506_123_456n))],
  ["bindTimeTZ", "SELECT $1 AS v", (p, api) => p.bindTimeTZ(1, api.timeTZValue(49_506_000_000n, 19_800))],
  ["bindTimestamp", "SELECT $1 AS v", (p, api) => p.bindTimestamp(1, api.timestampValue(1_752_327_906_123_456n))],
  ["bindTimestampTZ", "SELECT $1 AS v", (p, api) => p.bindTimestampTZ(1, api.timestampTZValue(1_752_327_906_123_456n))],
  [
    "bindTimestampTZNanoseconds",
    "SELECT $1 AS v",
    (p, api) => p.bindTimestampTZNanoseconds(1, api.timestampTZNanosValue(1_752_327_906_123_456_789n)),
  ],
  [
    "bindTimestampSeconds",
    "SELECT $1 AS v",
    (p, api) => p.bindTimestampSeconds(1, api.timestampSecondsValue(1_752_327_906n)),
  ],
  [
    "bindTimestampMilliseconds",
    "SELECT $1 AS v",
    (p, api) => p.bindTimestampMilliseconds(1, api.timestampMillisValue(1_752_327_906_123n)),
  ],
  [
    "bindTimestampNanoseconds",
    "SELECT $1 AS v",
    (p, api) => p.bindTimestampNanoseconds(1, api.timestampNanosValue(1_752_327_906_123_456_789n)),
  ],
  ["bindInterval", "SELECT $1 AS v", (p, api) => p.bindInterval(1, api.intervalValue(14, 3, 14_706_789_000n))],
  ["bindVarchar", "SELECT $1 AS v", (p) => p.bindVarchar(1, "résumé ✓ 🦆")],
  ["bindVarchar empty", "SELECT $1 AS v", (p) => p.bindVarchar(1, "")],
  ["bindBlob", "SELECT $1 AS v", (p) => p.bindBlob(1, new Uint8Array([0, 1, 254, 255]))],
  ["bindEnum", "SELECT $1 AS v", (p, api) => p.bindEnum(1, "ok", api.ENUM(["sad", "ok", "happy"]))],
  ["bindArray", "SELECT $1 AS v", (p, api) => p.bindArray(1, [1, 2, 3], api.ARRAY(api.INTEGER, 3))],
  ["bindArray without a type", "SELECT $1 AS v", (p) => p.bindArray(1, [1, 2, 3])],
  ["bindList", "SELECT $1 AS v", (p, api) => p.bindList(1, [1, 2, null], api.LIST(api.INTEGER))],
  ["bindList without a type", "SELECT $1 AS v", (p, api) => p.bindList(1, api.listValue(["a", "b"]))],
  [
    "bindList of decimals",
    "SELECT $1 AS v",
    (p, api) => p.bindList(1, [api.decimalValue(15n, 4, 1)], api.LIST(api.DECIMAL(4, 1))),
  ],
  ["bindList empty", "SELECT $1 AS v", (p, api) => p.bindList(1, [], api.LIST(api.VARCHAR))],
  [
    "bindStruct",
    "SELECT $1 AS v",
    (p, api) => p.bindStruct(1, { a: 1, b: "x" }, api.STRUCT({ a: api.INTEGER, b: api.VARCHAR })),
  ],
  ["bindStruct without a type", "SELECT $1 AS v", (p, api) => p.bindStruct(1, api.structValue({ a: 1, b: "x" }))],
  ["bindTuple", "SELECT $1 AS v", (p) => p.bindTuple(1, [1, "x"])],
  [
    "bindMap",
    "SELECT $1 AS v",
    (p, api) =>
      p.bindMap(
        1,
        api.mapValue([
          { key: "k1", value: 1 },
          { key: "k2", value: 2 },
        ]),
        api.MAP(api.VARCHAR, api.INTEGER),
      ),
  ],
  [
    "bindUnion",
    "SELECT $1 AS v",
    (p, api) => p.bindUnion(1, api.unionValue("s", "x"), api.UNION({ i: api.INTEGER, s: api.VARCHAR })),
  ],
  ["bindUUID", "SELECT $1 AS v", (p, api) => p.bindUUID(1, api.uuidValue(0x12345678123456781234567812345678n))],
  ["bindBit", "SELECT $1 AS v", (p, api) => p.bindBit(1, api.bitValue("101010"))],
  ["bindNull", "SELECT $1 AS v", (p) => p.bindNull(1)],
  ["bindNull into a typed parameter", "SELECT $1::DECIMAL(18,3) AS v", (p) => p.bindNull(1)],
  ["bindValue with a type", "SELECT $1 AS v", (p, api) => p.bindValue(1, 42, api.SMALLINT)],
  ["bindValue inferred", "SELECT $1 AS a, $2 AS b, $3 AS c, $4 AS d", (p) => p.bind([1, 2n, "x", true])],
  [
    "bind array with types",
    "SELECT $1 AS a, $2 AS b, $3 AS c",
    (p, api) => p.bind([1n, "2026-07-12", api.listValue([1.5, 2])], [api.BIGINT, api.VARCHAR, api.LIST(api.DOUBLE)]),
  ],
  [
    "bind record by name",
    "SELECT $amount::DECIMAL(18,3) AS amount, $name AS name, $day::DATE AS day",
    (p, api) => p.bind({ amount: api.decimalValue(12345n, 18, 3), name: "ann", day: "2026-07-12" }),
  ],
  [
    "bind record by name with types",
    "SELECT $a AS a, $b AS b",
    (p, api) => p.bind({ a: 1n, b: api.arrayValue([1, 2]) }, { a: api.HUGEINT, b: api.ARRAY(api.INTEGER, 2) }),
  ],
  [
    "bind by name through parameterIndex",
    "SELECT $first AS first, $second AS second",
    (p, api) => {
      p.bindVarchar(p.parameterIndex("second"), "two");
      p.bindTimestampTZ(p.parameterIndex("first"), api.timestampTZValue(0n));
    },
  ],
  [
    "positional ? parameters",
    "SELECT ?::INTEGER + ?::INTEGER AS sum, ? AS label",
    (p) => {
      p.bindInteger(1, 40);
      p.bindInteger(2, 2);
      p.bindVarchar(3, "answer");
    },
  ],
];

for (const [name, sql, bind] of BIND_CASES) {
  parity(`prepared ${name}`, bound(sql, bind), { official: "ok" });
}

const METADATA_STATEMENTS: Record<string, string> = {
  select: "SELECT $id::INTEGER AS id, $name AS name, 1.5::DECIMAL(18,3) AS d",
  insert: "INSERT INTO t VALUES ($1, $2)",
  update: "UPDATE t SET name = ? WHERE id = ?",
  delete: "DELETE FROM t WHERE id = $1",
  create: "CREATE TABLE u (i INTEGER)",
  explain: "EXPLAIN SELECT 1",
  pragma: "PRAGMA table_info('t')",
  set: "SET threads = 2",
};

// Isolated: reading the column type of some statements can crash a binding.
for (const [kind, sql] of Object.entries(METADATA_STATEMENTS)) {
  parity(
    `prepared statement metadata: ${kind}`,
    (api) =>
      withConnection(api, async (connection) => {
        await connection.run("CREATE TABLE t (id INTEGER, name VARCHAR)");
        const prepared = await connection.prepare(sql);
        return {
          statementType: prepared.statementType,
          parameterCount: prepared.parameterCount,
          parameterNames: Array.from({ length: prepared.parameterCount }, (_, i) => prepared.parameterName(i + 1)),
          // A parameter whose type DuckDB cannot infer throws; that error is part of the contract.
          parameterTypes: await Promise.all(
            Array.from({ length: prepared.parameterCount }, (_, i) =>
              capture(() => [prepared.parameterTypeId(i + 1), String(prepared.parameterType(i + 1))]),
            ),
          ),
          columnCount: prepared.columnCount,
          // Some statements (SET, for example) report a column of an invalid type, which throws.
          columns: await Promise.all(
            Array.from({ length: prepared.columnCount }, (_, i) =>
              capture(() => [prepared.columnName(i), prepared.columnTypeId(i), String(prepared.columnType(i))]),
            ),
          ),
        };
      }),
    { official: "ok", isolate: true },
  );
}

parity(
  "prepared statement reruns with new bindings, and rowsChanged",
  (api) =>
    withConnection(api, async (connection) => {
      await connection.run("CREATE TABLE t (id INTEGER, amount DECIMAL(18,3))");
      const insert = await connection.prepare("INSERT INTO t VALUES ($1, $2)");
      const changed: number[] = [];
      for (let i = 1; i <= 3; i++) {
        insert.bindInteger(1, i);
        insert.bindDecimal(2, api.decimalValue(BigInt(i * 1500), 18, 3));
        const result: DuckDBMaterializedResult = await insert.run();
        changed.push(result.rowsChanged);
      }
      insert.clearBindings();
      const missing = await capture(() => insert.run());
      return { changed, missing, rows: (await connection.runAndReadAll("SELECT * FROM t ORDER BY id")).getRowsJson() };
    }),
  { official: "ok" },
);

parity(
  "connection run and runAndReadAll with values",
  (api) =>
    withConnection(api, async (connection) => ({
      positional: readBack(await connection.runAndReadAll("SELECT $1 AS a, $2 AS b", [1, "x"])),
      named: readBack(
        await connection.runAndReadAll("SELECT $amount AS amount, $at AS at", {
          amount: api.decimalValue(12345n, 18, 3),
          at: api.timestampTZValue(1_752_327_906_123_456n),
        }),
      ),
      typed: readBack(
        await connection.runAndReadAll(
          "SELECT $1 AS a, $2 AS b",
          [1, api.listValue([1n, 2n])],
          [api.UTINYINT, api.LIST(api.BIGINT)],
        ),
      ),
      streamed: readBack(await connection.streamAndReadAll("SELECT $1 AS a", [api.dateValue(20_000)])),
    })),
  { official: "ok" },
);
