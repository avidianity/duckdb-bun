// Value parity: every reader accessor (getRows, getRowObjects, the Json and JS
// variants, getColumns) over each column of test_all_types(), and the value classes'
// toString(). Values compare as plain data: bigint as text, value objects as
// { class, string: toString(), fields }.

import type { DuckDBResultReader } from "@duckdb/node-api";
import * as official from "@duckdb/node-api";
import { type Api, capture, parityFor, withConnection } from "./harness.ts";

const parity = parityFor(import.meta.path);

/** Every accessor of a fully read reader, each captured on its own so one failure does not hide the others. */
async function readEveryWay(reader: DuckDBResultReader) {
  return {
    getRows: await capture(() => reader.getRows()),
    getRowObjects: await capture(() => reader.getRowObjects()),
    getRowsJson: await capture(() => reader.getRowsJson()),
    getRowObjectsJson: await capture(() => reader.getRowObjectsJson()),
    getRowsJS: await capture(() => reader.getRowsJS()),
    getRowObjectsJS: await capture(() => reader.getRowObjectsJS()),
    getColumns: await capture(() => reader.getColumns()),
    getColumnsJson: await capture(() => reader.getColumnsJson()),
    getColumnsObject: await capture(() => reader.getColumnsObject()),
    getColumnsObjectJson: await capture(() => reader.getColumnsObjectJson()),
  };
}

/**
 * The test_all_types() columns, and which ones the official binding itself cannot
 * read. A column whose values official reads but cannot convert in one accessor
 * (for example a DATE outside the JS Date range in getRowsJS) stays in: that
 * accessor's error is then the expected outcome.
 */
async function allTypesColumns(): Promise<{ name: string; officialReads: boolean }[]> {
  return withConnection(official, async (connection) => {
    const names = (await connection.runAndReadAll("SELECT * FROM test_all_types() LIMIT 0")).columnNames();
    const columns: { name: string; officialReads: boolean }[] = [];
    for (const name of names) {
      const outcome = await capture(async () => {
        const reader = await connection.runAndReadAll(`SELECT "${name}" FROM test_all_types()`);
        reader.getRows();
      });
      columns.push({ name, officialReads: "ok" in outcome });
    }
    return columns;
  });
}

for (const { name, officialReads } of await allTypesColumns()) {
  parity(
    `test_all_types() column ${name}`,
    (api) =>
      withConnection(api, async (connection) =>
        readEveryWay(await connection.runAndReadAll(`SELECT "${name}" FROM test_all_types()`)),
      ),
    { official: "ok", skip: !officialReads },
  );
}

parity(
  "rows of a typical table, every accessor",
  (api) =>
    withConnection(api, async (connection) => {
      await connection.run(`
        CREATE TABLE orders (
          id BIGINT, customer VARCHAR, amount DECIMAL(18,3), placed_at TIMESTAMPTZ, ship_date DATE,
          tags VARCHAR[], meta STRUCT(source VARCHAR, priority INTEGER), ref UUID, note VARCHAR
        );
        INSERT INTO orders VALUES
          (1, 'ann', 12.345, '2026-03-01 10:00:00+00', '2026-03-03', ['a', 'b'], {'source': 'web', 'priority': 1}, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', NULL),
          (2, 'bob', -0.001, '2026-03-02 23:59:59.999999+00', NULL, [], {'source': 'api', 'priority': NULL}, NULL, 'résumé ✓'),
          (3, NULL, NULL, NULL, '1970-01-01', NULL, NULL, NULL, '');
      `);
      return readEveryWay(await connection.runAndReadAll("SELECT * FROM orders ORDER BY id"));
    }),
  { official: "ok" },
);

parity(
  "duplicate column names in row objects",
  (api) =>
    withConnection(api, async (connection) => {
      const reader = await connection.runAndReadAll("SELECT 1 AS x, 2 AS x, 3 AS y");
      return { deduplicated: reader.deduplicatedColumnNames(), ...(await readEveryWay(reader)) };
    }),
  { official: "ok" },
);

parity(
  "multi-chunk result",
  (api) =>
    withConnection(api, async (connection) => {
      const reader = await connection.runAndReadAll(
        "SELECT i, i::VARCHAR AS s, (i * 1.5)::DECIMAL(10,1) AS d FROM range(5000) t(i)",
      );
      const rows = reader.getRowsJson();
      return { count: reader.currentRowCount, first: rows.slice(0, 3), last: rows.slice(-3) };
    }),
  { official: "ok" },
);

/** Value objects built with the API's constructor functions. */
function constructedValues(api: Api) {
  return [
    api.decimalValue(12345n, 18, 3),
    api.decimalValue(-5, 4, 1),
    api.dateValue(20_000),
    api.dateValue({ year: 2026, month: 7, day: 12 }),
    api.timeValue(49_506_123_456n),
    api.timeTZValue(49_506_000_000n, 19_800),
    api.timestampValue(1_752_327_906_123_456n),
    api.timestampTZValue(1_752_327_906_123_456n),
    api.timestampSecondsValue(1_752_327_906n),
    api.timestampMillisValue(1_752_327_906_123n),
    api.timestampNanosValue(1_752_327_906_123_456_789n),
    api.intervalValue(14, 3, 14_706_789_000n),
    api.uuidValue(0x12345678123456781234567812345678n),
    api.blobValue("hello"),
    api.blobValue(new Uint8Array([0, 1, 254, 255])),
    api.bitValue("101010"),
    api.listValue([1, "two", null]),
    api.arrayValue([1, 2, 3]),
    api.structValue({ a: 1, "b c": "x" }),
    api.mapValue([{ key: "k", value: 1 }]),
    api.unionValue("s", "text"),
  ];
}

parity("value classes' toString() for constructed values", async (api) =>
  constructedValues(api).map((value) => ({ class: value.constructor.name, string: value.toString() })),
);

parity(
  "value classes' toString() for queried values",
  (api) =>
    withConnection(api, async (connection) => {
      const reader = await connection.runAndReadAll(`
        SELECT 12.345::DECIMAL(18,3) AS d, DATE '2026-07-12' AS dt, TIME '13:45:06.123456' AS t,
          TIMETZ '13:45:06+05:30' AS ttz, TIMESTAMP '2026-07-12 13:45:06.123456' AS ts,
          TIMESTAMPTZ '2026-07-12 13:45:06.123456+00' AS tstz, TIMESTAMP_S '2026-07-12 13:45:06' AS tss,
          TIMESTAMP_MS '2026-07-12 13:45:06.123' AS tsms, TIMESTAMP_NS '2026-07-12 13:45:06.123456789' AS tsns,
          INTERVAL '1 year 2 months 3 days 04:05:06.789' AS i, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::UUID AS u,
          '\\x00\\xFF'::BLOB AS b, '1010'::BIT AS bit, [1, 2] AS l, [1, 2]::INTEGER[2] AS a, {'k': 'v'} AS s,
          MAP {'k': 1} AS m, union_value(n := 1) AS un
      `);
      const row = reader.getRows()[0];
      return reader.columnNames().map((name, i) => ({ name, class: row[i]?.constructor.name, string: String(row[i]) }));
    }),
  { official: "ok" },
);

parity(
  "every accessor over the types the fuzz targets cover, with NULLs at every level",
  (api) =>
    withConnection(api, async (connection) =>
      readEveryWay(
        await connection.runAndReadAll(`
          SELECT TIME_NS '13:45:06.123456789' AS tns, '2026-07-12 13:45:06.123456789+00'::TIMESTAMPTZ_NS AS tstzns,
            'POINT(1 2)'::GEOMETRY AS g, {'a': [1, NULL], 'b': 'x'}::VARIANT AS v,
            [{'v': 42::VARIANT, 'g': NULL::GEOMETRY}, NULL] AS nested,
            MAP {'k': [NULL, 'POINT(3 4)'::GEOMETRY]} AS m
          UNION ALL
          SELECT NULL, NULL, NULL, NULL, [NULL], MAP {'k': NULL}
        `),
      ),
    ),
  { official: "ok" },
);
