// Column type parity: the DuckDBType objects a result reports, their toString()
// (for example 'DECIMAL(18,3)' and 'TIMESTAMP WITH TIME ZONE'), and their JSON forms.
import type { DuckDBResultReader } from "@duckdb/node-api";
import { parityFor, withConnection } from "./harness.ts";

const parity = parityFor(import.meta.path);

/** Every type view a reader offers, plus the decoded values as JSON. */
function describeColumns(reader: DuckDBResultReader) {
  return {
    names: reader.columnNames(),
    strings: reader.columnTypes().map(String),
    typeIds: reader.columnNames().map((_, i) => reader.columnTypeId(i)),
    types: reader.columnTypes(),
    typesJson: reader.columnTypesJson(),
    namesAndTypesJson: reader.columnNamesAndTypesJson(),
    nameAndTypeObjectsJson: reader.columnNameAndTypeObjectsJson(),
    rowsJson: reader.getRowsJson(),
  };
}

// [type, a literal of that type]
const TYPES: [type: string, literal: string][] = [
  ["DECIMAL(4,1)", "123.4"],
  ["DECIMAL(5,0)", "12345"],
  ["DECIMAL(9,2)", "1234567.89"],
  ["DECIMAL(18,3)", "123456789012345.678"],
  ["DECIMAL(18,6)", "-0.000001"],
  ["DECIMAL(38,10)", "1234567890123456789012345678.0123456789"],
  ["TIMESTAMP WITH TIME ZONE", "'2026-07-12 13:45:06.123456+00'"],
  ["TIMESTAMP", "'2026-07-12 13:45:06.123456'"],
  ["TIMESTAMP_S", "'2026-07-12 13:45:06'"],
  ["TIMESTAMP_MS", "'2026-07-12 13:45:06.123'"],
  ["TIMESTAMP_NS", "'2026-07-12 13:45:06.123456789'"],
  ["DATE", "'2026-07-12'"],
  ["TIME", "'13:45:06.123456'"],
  ["TIME WITH TIME ZONE", "'13:45:06+05:30'"],
  ["INTERVAL", "INTERVAL '1 year 2 months 3 days 04:05:06.789'"],
  ["UUID", "'12345678-1234-5678-1234-567812345678'"],
  ["BLOB", "'\\xDE\\xAD\\xBE\\xEF'"],
  ["VARCHAR", "'hello, world'"],
  ["BOOLEAN", "true"],
  ["TINYINT", "-128"],
  ["INTEGER", "2147483647"],
  ["BIGINT", "9223372036854775807"],
  ["HUGEINT", "-170141183460469231731687303715884105728"],
  ["UHUGEINT", "340282366920938463463374607431768211455"],
  ["FLOAT", "1.5"],
  ["DOUBLE", "3.141592653589793"],
  ["BIT", "'101010'"],
  ["BIGNUM", "'123456789012345678901234567890'"],
  ["INTEGER[]", "[1, 2, NULL, 4]"],
  ["VARCHAR[]", "['a', NULL, 'c']"],
  ["STRUCT(a INTEGER, b VARCHAR)", "{'a': 1, 'b': 'x'}"],
  ['STRUCT("quoted name" INTEGER, "x y" DOUBLE)', "{'quoted name': 1, 'x y': 2.5}"],
  ["MAP(VARCHAR, INTEGER)", "MAP {'k1': 1, 'k2': 2}"],
  ["ENUM('sad', 'ok', 'happy')", "'ok'"],
  ["UNION(i INTEGER, s VARCHAR)", "'text'"],
  ["INTEGER[3]", "[1, 2, 3]"],
  ["STRUCT(a INTEGER[], m MAP(VARCHAR, DATE))[]", "[{'a': [1], 'm': MAP {'d': DATE '2026-01-01'}}]"],
  ["JSON", "'{\"a\": [1, 2]}'"],
];

for (const [type, literal] of TYPES) {
  parity(
    `column type ${type}`,
    (api) =>
      withConnection(api, async (connection) =>
        describeColumns(
          await connection.runAndReadAll(`SELECT CAST(${literal} AS ${type}) AS v, CAST(NULL AS ${type}) AS n`),
        ),
      ),
    { official: "ok" },
  );
}

parity(
  "column types of a user-defined ENUM",
  (api) =>
    withConnection(api, async (connection) => {
      await connection.run("CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')");
      return describeColumns(await connection.runAndReadAll("SELECT 'happy'::mood AS m, ['sad', 'ok']::mood[] AS ms"));
    }),
  { official: "ok" },
);

parity(
  "column types of a table, by name and by alias",
  (api) =>
    withConnection(api, async (connection) => {
      await connection.run(
        "CREATE TABLE t (amount DECIMAL(18,3), created_at TIMESTAMPTZ, day DATE, id UUID, tags VARCHAR[], meta STRUCT(k VARCHAR, v BIGINT))",
      );
      await connection.run(
        "INSERT INTO t VALUES (12.5, '2026-01-02 03:04:05+00', '2026-01-02', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', ['x'], {'k': 'a', 'v': 1})",
      );
      return describeColumns(await connection.runAndReadAll('SELECT *, amount AS "Amount Alias" FROM t'));
    }),
  { official: "ok" },
);

parity(
  "column types reported before reading any rows",
  (api) =>
    withConnection(api, async (connection) => {
      const result = await connection.stream("SELECT 1.5::DECIMAL(18,3) AS d, now()::TIMESTAMPTZ AS t, [1] AS l");
      return {
        names: result.columnNames(),
        strings: result.columnTypes().map(String),
        typesJson: result.columnTypesJson(),
        namesAndTypesJson: result.columnNamesAndTypesJson(),
      };
    }),
  { official: "ok" },
);

parity(
  "prepared statement column and parameter types",
  (api) =>
    withConnection(api, async (connection) => {
      const prepared = await connection.prepare(
        "SELECT $1::DECIMAL(18,3) AS d, $2::TIMESTAMPTZ AS t, $3::MAP(VARCHAR, INTEGER) AS m, $4::INTEGER[2] AS a",
      );
      const columns = Array.from({ length: prepared.columnCount }, (_, i) => ({
        name: prepared.columnName(i),
        typeId: prepared.columnTypeId(i),
        type: String(prepared.columnType(i)),
      }));
      const parameters = Array.from({ length: prepared.parameterCount }, (_, i) => ({
        typeId: prepared.parameterTypeId(i + 1),
        type: String(prepared.parameterType(i + 1)),
      }));
      return { columns, parameters };
    }),
  { official: "ok" },
);
