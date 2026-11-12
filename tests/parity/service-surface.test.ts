// Service surface parity: the calls, argument shapes, and SQL features a long-running
// service makes through the API, each compared with the official binding on synthetic
// data. It covers an in-memory instance built from string options, a hardening SET
// sequence that ends in lock_configuration, `?` and `$n` parameters, set variable and
// getvariable, json_serialize_sql, NDJSON and CSV reads, COPY to Parquet and a
// read_parquet view, stream() read chunk by chunk with fetchChunk and with for await,
// columnTypes() before any row, the date, decimal, and timestamp value classes checked
// with instanceof, the out-of-memory error texts, and interrupt through a pending result.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection, DuckDBResult } from "@duckdb/node-api";
import { type Api, capture, OFFLINE, parityFor, withConnection } from "./harness.ts";

const parity = parityFor(import.meta.path);

const OK = { official: "ok" } as const;

/** Runs `sql` with run() and returns the materialized rows, the way a caller reads a one-row answer. */
async function rows(connection: DuckDBConnection, sql: string, values?: unknown[]) {
  const result = await connection.run(sql, values as never);
  return result.getRows();
}

/** A value as a caller tells it apart: its JS type, or the value class it is an instance of, with that class's text. */
function cell(api: Api, value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return { type: typeof value, text: String(value) };
  const classes = ["DuckDBDateValue", "DuckDBDecimalValue", "DuckDBTimestampTZValue", "DuckDBTimestampValue"] as const;
  for (const name of classes) {
    const valueClass = api[name];
    if (value instanceof valueClass) {
      return { type: name, text: valueClass.prototype.toString.apply(value as never) };
    }
  }
  return { type: "other", class: value.constructor.name };
}

/** Every chunk of a streamed result, read with fetchChunk until it answers null or an empty chunk. */
async function fetchAll(result: DuckDBResult) {
  const chunks: unknown[][][] = [];
  for (;;) {
    const chunk = await result.fetchChunk();
    if (chunk === null || chunk.rowCount === 0) return chunks;
    chunks.push(chunk.getRows());
  }
}

const SETTING_NAMES = [
  "TimeZone",
  "allocator_background_threads",
  "default_collation",
  "max_temp_directory_size",
  "memory_limit",
  "preserve_insertion_order",
  "temp_directory",
  "threads",
];

parity(
  "an in-memory instance from string options, read back",
  (api, { tmp }) => {
    const options = {
      default_collation: "nocase",
      TimeZone: "UTC",
      threads: "2",
      allocator_background_threads: "true",
      memory_limit: `${256 * 1024 * 1024}B`,
      max_temp_directory_size: `${1024 * 1024}B`,
      temp_directory: join(tmp, "spill"),
      preserve_insertion_order: "false",
    };
    return withConnection(
      api,
      async (connection) => ({
        settings: (
          await connection.runAndReadAll(
            `SELECT name, value FROM duckdb_settings() WHERE name IN (${SETTING_NAMES.map((n) => `'${n}'`).join(", ")}) ORDER BY name`,
          )
        ).getRows(),
        threads: Number((await connection.runAndReadAll("select current_setting('threads')")).getRowsJS()[0]?.[0]),
        nocase: await rows(
          connection,
          "SELECT 'DINNER2025' = 'Dinner2025', 'B' IN ('a', 'b'), count(*) FROM (VALUES ('X'), ('x')) t(v) WHERE v = 'x'",
        ),
        utc: await rows(
          connection,
          "SELECT cast(TIMESTAMPTZ '2026-01-15 03:00:00+05' AS date), date_trunc('day', TIMESTAMPTZ '2026-01-15 23:30:00+00')",
        ),
      }),
      ":memory:",
      options,
    );
  },
  OK,
);

/** The settings a service applies to a fresh instance before it hands out connections, in order. */
function hardening(allowed: string[]): string[] {
  return [
    "set global threads = 2",
    "set allow_unsigned_extensions = false",
    "set allow_community_extensions = false",
    "set autoinstall_known_extensions = false",
    "set autoload_known_extensions = false",
    "set allow_persistent_secrets = false",
    "set allow_unredacted_secrets = false",
    "set enable_external_file_cache = false",
    "set enable_http_metadata_cache = false",
    "set enable_object_cache = false",
    "set enable_http_logging = false",
    "set enable_logging = false",
    "set log_query_path = ''",
    "set parquet_metadata_cache = false",
    `set allowed_directories = [${allowed.map((path) => `'${path}'`).join(", ")}]`,
    "set enable_external_access = false",
    "set lock_configuration = true",
  ];
}

parity(
  "hardening SET sequence, locked configuration, and allowed directories",
  (api, { tmp }) => {
    const allowed = join(tmp, "allowed");
    const other = join(tmp, "other");
    mkdirSync(allowed);
    mkdirSync(other);
    writeFileSync(join(allowed, "in.csv"), "a,b\n1,2\n");
    writeFileSync(join(other, "out.csv"), "a,b\n3,4\n");
    return withConnection(api, async (connection, instance) => {
      const applied: unknown[] = [];
      for (const sql of hardening([`${allowed}/`, `${tmp}/spill/`])) {
        applied.push({ sql: sql.replaceAll(tmp, "<tmp>"), outcome: await capture(() => connection.run(sql)) });
      }
      // Settings belong to the instance: a later connection sees them too.
      const later = await instance.connect();
      try {
        return {
          applied,
          settings: await rows(
            later,
            "SELECT name, value FROM duckdb_settings() WHERE name IN ('enable_external_access', 'lock_configuration', 'threads', 'autoload_known_extensions') ORDER BY name",
          ),
          unlock: await capture(() => later.run("set allow_community_extensions = true")),
          debugForceExternal: await capture(() => later.run("set debug_force_external = true")),
          inside: await capture(() => rows(later, `SELECT * FROM read_csv('${allowed}/in.csv')`)),
          outside: await capture(() => rows(later, `SELECT * FROM read_csv('${other}/out.csv')`)),
        };
      } finally {
        later.closeSync();
      }
    });
  },
  OK,
);

parity(
  "? parameters with run(): set variable, getvariable, and json_serialize_sql round trip",
  (api) =>
    withConnection(api, async (connection) => {
      await connection.run("set variable some_path = ?", ["/data/a b's.parquet"]);
      const serialized = (
        await rows(connection, "select json_serialize_sql(cast(? as varchar))", [
          "select c1, sum(c2) from dataset where c3 = 'x' group by c1 order by 2 desc limit 5",
        ])
      )[0]?.[0];
      const failed = (await rows(connection, "select json_serialize_sql(cast(? as varchar))", ["selec nope"]))[0]?.[0];
      await connection.run("CREATE TABLE dataset AS SELECT * FROM (VALUES (1, 'a'), (1, 'a'), (NULL, 'b')) t(c1, c2)");
      return {
        variable: await rows(connection, "select getvariable('some_path')"),
        serialized,
        failed,
        deserialized: await rows(connection, "select json_deserialize_sql(cast(? as varchar))", [serialized]),
        repeats: await rows(
          connection,
          "select exists (select 1 from dataset where c1 is not null and c2 is not null group by c1, c2 having count(*) > 1)",
        ),
        none: await rows(
          connection,
          "select exists (select 1 from dataset where c2 is not null group by c2, c1 having count(*) > 2)",
        ),
      };
    }),
  OK,
);

const LOG_LINES: Record<string, string[]> = {
  "2026-01-15/08/a.ndjson": [
    JSON.stringify({
      id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      at: "2026-01-15T08:10:00.000Z",
      level: "info",
      message: "Request done",
      context: { route: "/x", ms: 12, ok: true, tags: ["a", "b"], nested: { k: "v" } },
    }),
    JSON.stringify({
      id: "B0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A12",
      at: "2026-01-15T08:50:00.250Z",
      level: "error",
      message: "Query failed",
      context: { route: "/y", ms: 140.5, ok: false, tags: [], "a/b": "slash" },
    }),
    '{"id": "not-a-uuid", "at": "2026-01-15T08:20:00Z", "level": "info", "message": "x", "context": {}}',
    '{"id": "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13", "at": "2026-01-15T08:3',
  ],
  "2026-01-15/09/b.ndjson": [
    JSON.stringify({
      id: "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13",
      at: "2026-01-15T09:05:00.000Z",
      level: "warn",
      message: "Slow résumé ✓",
      context: { route: "/x", ms: 900, tags: ["b", { deep: 1 }] },
    }),
    JSON.stringify({
      id: "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13",
      at: "2026-01-15T09:05:00.000Z",
      level: "warn",
      message: "Slow résumé ✓",
      context: { route: "/x", ms: 900, tags: ["b", { deep: 1 }] },
    }),
    JSON.stringify({ id: "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14", at: "2026-01-15T09:06:00Z", context: [] }),
  ],
};

function writeLogs(folder: string): void {
  for (const [path, lines] of Object.entries(LOG_LINES)) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), `${lines.join("\n")}\n`);
  }
}

/** Every valid line of the NDJSON files under `folder` that `files` keeps, as one relation. */
function logLines(folder: string, glob: string, files: string): string {
  return `select * from (
      select cast(try_cast(id as UUID) as VARCHAR) as id,
        epoch_ms(try_cast("at" as TIMESTAMPTZ)) as ms, level, message, context
      from read_json('${folder}/${glob}', format = 'newline_delimited', ignore_errors = true,
        filename = true, columns = {'id': 'VARCHAR', 'at': 'VARCHAR', 'level': 'VARCHAR',
        'message': 'VARCHAR', 'context': 'JSON'})
      where ${files}
    )
    where id is not null and ms is not null and message is not null
      and level in ('info', 'warn', 'error') and json_type(context) = 'OBJECT'`;
}

parity(
  "NDJSON log reads with read_json, JSON functions, and $n parameters through runAndReadAll",
  (api, { tmp }) => {
    const folder = join(tmp, "logs");
    writeLogs(folder);
    return withConnection(
      api,
      async (connection) => {
        const lines = logLines(folder, "*/*/*.ndjson", `filename >= '${folder}/2026-01-15/08/'`);
        const query = async (sql: string, values: unknown[] = []) =>
          (await connection.runAndReadAll(sql, values as never)).getRowsJS();
        return {
          list: await query(
            `select distinct on (id) id, cast(ms as DOUBLE), level, message, cast(context as VARCHAR)
             from (${lines}) where ms >= cast($1 as DOUBLE) and contains(lower(message), lower(cast($2 as VARCHAR)))`,
            [Date.parse("2026-01-15T08:00:00Z"), "É"],
          ).then((found) => found.toSorted((a, b) => String(a[0]).localeCompare(String(b[0])))),
          page: await query(
            `select id, cast(max(ms) as DOUBLE) from (${lines}) where id < cast($1 as VARCHAR) group by id order by id desc limit 10`,
            ["ffffffff"],
          ),
          counts: await query(
            `select level, cast(count(*) as INTEGER), cast(count(distinct (case when json_type(context, '/route') = 'VARCHAR' then json_extract_string(context, '/route') end)) as INTEGER),
               max(case when json_type(context, '/ms') in ('BIGINT', 'UBIGINT', 'DOUBLE') then cast(json_extract(context, '/ms') as DOUBLE) end),
               sum(case when json_type(context, '/ms') in ('BIGINT', 'UBIGINT', 'DOUBLE') then cast(json_extract(context, '/ms') as DOUBLE) end),
               avg(case when json_type(context, '/ms') in ('BIGINT', 'UBIGINT', 'DOUBLE') then cast(json_extract(context, '/ms') as DOUBLE) end),
               cast(max(ms) as DOUBLE)
             from (select distinct on (id) * from (${lines})) group by 1 order by 2 desc nulls last, 1`,
          ),
          buckets: await query(
            `select cast(epoch_ms(date_trunc('hour', make_timestamp(ms * 1000))) as DOUBLE), cast(count(*) as INTEGER)
             from (${lines}) group by 1 order by 1`,
          ),
          containment: await query(
            `select id from (${lines}) where
               (case when json_type(context) = 'OBJECT' then true and
                 (case when json_type(json_extract(context, '/tags')) = 'ARRAY' then true and
                   coalesce(list_bool_or(list_transform(json_extract(json_extract(context, '/tags'), '$[*]'),
                     lambda element0: (case when json_type(element0) = 'VARCHAR' then json_extract_string(element0, '$') = cast($1 as VARCHAR) else false end))), false)
                 else false end) and
                 (case when json_type(json_extract(context, '/ok')) = 'BOOLEAN' then cast(json_extract(context, '/ok') as BOOLEAN) = cast($2 as BOOLEAN) else false end)
               else false end)
             order by id`,
            ["b", false],
          ),
          pointer: await query(`select json_extract_string(context, '/a~1b') from (${lines}) where level = 'error'`),
          noFiles: await capture(() => query(`select * from (${logLines(join(tmp, "none"), "*/*/*.ndjson", "true")})`)),
          noLogs: await query(
            "select null::VARCHAR as id, null::BIGINT as ms, null::VARCHAR as level, null::VARCHAR as message, null::JSON as context where false",
          ),
        };
      },
      ":memory:",
      { TimeZone: "UTC" },
    );
  },
  OK,
);

const STAGED = [
  [1, "42", "12.50", "true", "2026-01-15", "2026-01-15T08:30:00.000Z", "plain", "true"],
  [2, "-7", "0.01", "false", "1999-12-31", "2026-01-15T00:00:00.000Z", "", "false"],
  [3, null, null, null, null, null, null, null],
  [4, "9007199254740993", "-99999.99", "true", "2026-02-28", "2026-03-01T23:59:59.123Z", "x", "maybe", "7:Maybe!"],
];

/** The staged rows as one `r` list per line, `r[1]` the row position and `r[2]` on the cells, then texts kept as `<index>:<text>`. */
function stagedRows(path: string): string {
  return `read_json('${path}', format = 'newline_delimited', records = false, compression = 'uncompressed', columns = {r: 'VARCHAR[]'}, maximum_object_size = ${16 * 1024 * 1024})`;
}

const TYPED_SELECT = [
  "cast(r[1] as bigint) as _row",
  "cast(r[2] as bigint) as c1",
  "cast(r[3] as decimal(12, 2)) as c2",
  "cast(r[4] as boolean) as c3",
  "cast(r[5] as date) as c4",
  "cast(r[6] as timestamptz) as c5",
  "cast(r[7] as varchar) as c6",
  // A boolean column widened to text: the kept source text if any, else Yes or No.
  "coalesce(list_filter(r[10:], lambda t: starts_with(t, '7:'))[1][3:], case r[8] when 'true' then 'Yes' when 'false' then 'No' end) as c7",
  "case when ends_with(r[6], 'T00:00:00.000Z') then left(r[6], 10) else regexp_replace(regexp_replace(r[6], 'Z$', ''), '\\.?0+$', '') end as c8",
].join(", ");

parity(
  "COPY staged NDJSON to Parquet, a read_parquet view, and a fetchChunk stream of value classes",
  (api, { tmp }) => {
    const staged = join(tmp, "staged.ndjson");
    writeFileSync(staged, `${STAGED.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const parquet = join(tmp, "out.parquet");
    return withConnection(
      api,
      async (connection) => {
        const copied = await rows(
          connection,
          `copy (select ${TYPED_SELECT} from ${stagedRows(staged)}) to '${parquet}' (format parquet)`,
        );
        await connection.run("set variable dataset_path_1 = ?", [parquet]);
        await connection.run(
          "create or replace temp view dataset_1 as select * from read_parquet(getvariable('dataset_path_1'))",
        );
        await connection.run("create or replace temp view dataset as select * from dataset_1");
        await connection.run(
          "create or replace temp view projected as select * exclude (_row) from read_parquet(getvariable('dataset_path_1'))",
        );
        const streamed = await connection.stream("select * from dataset where _row > 1");
        const chunks = await fetchAll(streamed);
        return {
          copied: copied.map((row) => row.map((value) => cell(api, value))),
          described: await rows(connection, "describe (select * from projected)"),
          cells: chunks.map((chunk) => chunk.map((row) => row.map((value) => cell(api, value)))),
          projectedNames: (await connection.runAndReadAll("select * from projected limit 0")).columnNames(),
        };
      },
      ":memory:",
      { TimeZone: "UTC", preserve_insertion_order: "true" },
    );
  },
  OK,
);

parity(
  "stream() column names and types before any row, then for await over chunks",
  (api) =>
    withConnection(
      api,
      async (connection) => {
        await connection.run(`CREATE TABLE t AS SELECT i AS c1, (i % 7)::VARCHAR AS c2, (i * 1.25)::DECIMAL(10, 2) AS c3,
          i % 2 = 0 AS c4, DATE '2026-01-01' + (i % 30)::INTEGER AS c5,
          TIMESTAMP '2026-01-01 00:00:00' + to_seconds(i) AS c6, TIMESTAMPTZ '2026-01-01 00:00:00+00' + to_seconds(i) AS c7
          FROM range(5000) t(i)`);
        const grouped: DuckDBResult = await connection.stream(
          "select c2, sum(c1), avg(c1), count(*), sum(c3), min(c5), max(c6), max(c7), bool_or(c4), cast(1 as integer), cast(1 as smallint) from t group by c2 order by c2",
        );
        const names = grouped.columnNames();
        const types = grouped.columnTypes().map((type) => type.toString());
        const groupedRows: unknown[] = [];
        for await (const chunk of grouped) {
          for (const row of chunk.getRows()) groupedRows.push(row.map((value) => cell(api, value)));
        }
        const wide = await connection.stream("select * from t order by c1");
        let count = 0;
        let chunks = 0;
        let last: unknown[] = [];
        for await (const chunk of wide) {
          chunks += 1;
          for (const row of chunk.getRows()) {
            count += 1;
            last = row.map((value) => cell(api, value));
          }
        }
        return { names, types, groupedRows, wide: { count, chunks, last } };
      },
      ":memory:",
      { TimeZone: "UTC" },
    ),
  OK,
);

parity(
  "streamed read_csv with fixed options, and DuckDB's error for a ragged file",
  (api, { tmp }) => {
    const good = join(tmp, "good.csv");
    const ragged = join(tmp, "ragged.csv");
    writeFileSync(good, 'Name,Note,Amount\n"Smith, Ann","said ""hi""",12.5\nBob,,\n,,\n"multi\nline",x,1\n');
    writeFileSync(ragged, "a,b,c\n1,2,3\n4,5\n");
    const options =
      "header = false, all_varchar = true, delim = ',', quote = '\"', escape = '\"', skip = 0, strict_mode = true, null_padding = false";
    return withConnection(api, async (connection) => {
      const read = async (path: string) => {
        await connection.run("set variable csv_path = ?", [path]);
        const result = await connection.stream(
          `select * from read_csv(getvariable('csv_path'), ${options}, max_line_size = ${1024 * 1024})`,
        );
        return (await fetchAll(result))
          .flat()
          .map((row) => row.map((value) => (typeof value === "string" ? value : "")));
      };
      return { good: await capture(() => read(good)), ragged: await capture(() => read(ragged)) };
    });
  },
  OK,
);

parity(
  "the error text when a query runs out of memory with no temporary directory",
  (api) =>
    withConnection(
      api,
      async (connection) => {
        const outcome = await capture(
          async () =>
            (
              await connection.runAndReadAll(
                "select i, row_number() over (order by 'row ' || i, i desc) from range(200000) t(i)",
              )
            ).currentRowCount,
        );
        return {
          // The message names the bytes in use, which vary run to run; its kind does not.
          kind: "error" in outcome ? outcome.error.message.split(":")[0] : "completed",
          mentionsTempLimit: "error" in outcome && /max_temp_directory_size/.test(outcome.error.message),
          after: await rows(connection, "select 1"),
        };
      },
      ":memory:",
      { memory_limit: "2MB", threads: "1", temp_directory: "" },
    ),
  { official: "ok", isolate: true, timeout: 60_000 },
);

parity(
  "the error text when a query fills max_temp_directory_size",
  (api, { tmp }) =>
    withConnection(
      api,
      async (connection) => {
        await connection.run("set debug_force_external = true");
        const configured = await rows(
          connection,
          "select value from duckdb_settings() where name = 'max_temp_directory_size'",
        );
        const outcome = await capture(
          async () =>
            (
              await connection.runAndReadAll(
                "select random() as a, random() as b, random() as c, random() as d from range(2000000) order by a",
              )
            ).currentRowCount,
        );
        const message = "error" in outcome ? outcome.error.message : "";
        return {
          configured,
          kind: message.split(":")[0],
          tempBudget:
            /Out of Memory Error: (?:failed to offload data block[\s\S]*max_temp_directory_size|failed to pin block)/.test(
              message,
            ),
          after: await rows(connection, "select 2"),
        };
      },
      ":memory:",
      {
        memory_limit: "32MB",
        max_temp_directory_size: "262144B",
        temp_directory: join(tmp, "spill"),
        threads: "1",
        preserve_insertion_order: "false",
      },
    ),
  { official: "ok", isolate: true, timeout: 60_000 },
);

parity(
  "duckdb_memory() totals as a service samples them",
  (api) =>
    withConnection(api, async (connection) => {
      const reader = await connection.runAndReadAll(
        "select coalesce(sum(memory_usage_bytes), 0), coalesce(sum(temporary_storage_bytes), 0) from duckdb_memory()",
      );
      // The byte counts depend on what the process did before; their types do not.
      return { types: reader.columnTypes().map(String), kinds: reader.getRows()[0]?.map((value) => typeof value) };
    }),
  OK,
);

parity(
  "classes the API hands out, and which prototype methods its convenience calls go through",
  async (api) => {
    const instance = await api.DuckDBInstance.create(":memory:");
    const [first, second] = await Promise.all([instance.connect(), instance.connect()]);
    const prototype = api.DuckDBConnection.prototype;
    const original = { run: prototype.run, stream: prototype.stream };
    const calls: string[] = [];
    prototype.run = function (this: DuckDBConnection, ...args: Parameters<DuckDBConnection["run"]>) {
      calls.push(`run ${args[0]}`);
      return original.run.apply(this, args);
    };
    prototype.stream = function (this: DuckDBConnection, ...args: Parameters<DuckDBConnection["stream"]>) {
      calls.push(`stream ${args[0]}`);
      return original.stream.apply(this, args);
    };
    try {
      await first.runAndReadAll("select 1");
      await first.streamAndReadAll("select 2");
      await (await first.run("select 3")).getRows();
      await fetchAll(await second.stream("select 4"));
      const both = await Promise.all([rows(first, "select 5"), rows(second, "select 6")]);
      return {
        classes: [
          instance instanceof api.DuckDBInstance,
          first instanceof api.DuckDBConnection,
          (await first.run("select 1")) instanceof api.DuckDBMaterializedResult,
          (await first.stream("select 1")) instanceof api.DuckDBResult,
        ],
        calls,
        both,
      };
    } finally {
      prototype.run = original.run;
      prototype.stream = original.stream;
      first.closeSync();
      second.closeSync();
      instance.closeSync();
    }
  },
  OK,
);

parity(
  "a pending result's runTask, an interrupt, then the same connection runs on",
  (api) =>
    withConnection(api, async (connection, instance) => {
      const other = await instance.connect();
      try {
        const pending = await connection.start("select sum(i) from range(10000000000) t(i)");
        const state = pending.runTask();
        connection.interrupt();
        return {
          // Not finished. Which of the two not-finished states the first task returns depends on whether
          // DuckDB's own threads took the tasks first, so neither binding can promise one of them.
          unfinished: [
            api.DuckDBPendingResultState.RESULT_NOT_READY,
            api.DuckDBPendingResultState.NO_TASKS_AVAILABLE,
          ].includes(state),
          // Each step is captured: whether a connection with an unread pending result takes a new query is part of the contract.
          seven: await capture(() => rows(connection, "select 7")),
          missing: await capture(() => connection.run("select missing_function()")),
          eight: await capture(() => rows(connection, "select 8")),
          nine: await capture(() => rows(other, "select 9")),
        };
      } finally {
        other.closeSync();
      }
    }),
  { official: "ok", isolate: true, timeout: 30_000 },
);

parity(
  "an interrupt sent before a query begins is discarded",
  (api) =>
    withConnection(api, async (connection) => {
      connection.interrupt();
      return {
        run: await capture(() => rows(connection, "select 42")),
        stream: await capture(async () => fetchAll(await connection.stream("select 43"))),
      };
    }),
  { official: "ok", isolate: true, timeout: 30_000 },
);

parity(
  "repeated interrupts stop a stream() read chunk by chunk",
  (api) =>
    withConnection(api, async (connection) => {
      const timer = setInterval(() => connection.interrupt(), 10);
      let outcome: unknown;
      try {
        outcome = await capture(async () => {
          const result = await connection.stream("select i, hash(i) from range(5000000000) t(i) order by 2");
          return (await fetchAll(result)).length;
        });
      } finally {
        clearInterval(timer);
      }
      return { outcome, after: await rows(connection, "select 1") };
    }),
  { official: "ok", isolate: true, timeout: 30_000 },
);

parity(
  "a new query on a connection whose streamed or pending result is still open",
  (api) =>
    withConnection(api, async (connection) => {
      const streamed = await connection.stream("select i from range(100000) t(i)");
      const first = (await streamed.fetchChunk())?.rowCount;
      const whileStreaming = await capture(() => rows(connection, "select 1"));
      const rest = (await fetchAll(streamed)).reduce((sum, chunk) => sum + chunk.length, 0);
      const afterDrain = await capture(() => rows(connection, "select 2"));
      const pending = await connection.start("select 3");
      const whilePending = await capture(() => rows(connection, "select 4"));
      const pendingRows = await capture(async () => (await pending.readAll()).getRows());
      return {
        first,
        whileStreaming,
        rest,
        afterDrain,
        whilePending,
        pendingRows,
        after: await rows(connection, "select 5"),
      };
    }),
  OK,
);

parity(
  "a connection and its instance closed with closeSync, then used",
  async (api) => {
    const instance = await api.DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    await rows(connection, "select 1");
    connection.closeSync();
    instance.closeSync();
    return {
      run: await capture(() => connection.run("select 1")),
      connect: await capture(() => instance.connect()),
    };
  },
  { official: "ok", isolate: true },
);

parity(
  "an instance with installing off loads azure and icu, uses the curl transport and a temporary azure secret",
  (api, { shared }) => {
    const extensions = { extension_directory: join(shared, "extensions") };
    return (async () => {
      // A build step installs the extensions; the running service only loads them.
      await withConnection(
        api,
        async (connection) => {
          await connection.run("install azure");
          await connection.run("install icu");
        },
        ":memory:",
        extensions,
      );
      return withConnection(
        api,
        async (connection) => {
          for (const sql of [
            "set autoinstall_known_extensions = false",
            "set autoload_known_extensions = false",
            "load azure",
            "load icu",
            "set TimeZone = 'UTC'",
            "set global azure_transport_option_type = 'curl'",
            "set allow_persistent_secrets = false",
          ]) {
            await connection.run(sql);
          }
          await connection.run(
            "create temporary secret dataset_azure (type azure, connection_string 'DefaultEndpointsProtocol=https;AccountName=example;AccountKey=a2V5;EndpointSuffix=core.windows.net', scope 'azure://container/')",
          );
          return {
            secrets: await rows(
              connection,
              "select name, type, provider, persistent, storage, scope from duckdb_secrets()",
            ),
            transport: await rows(connection, "select current_setting('azure_transport_option_type')"),
            loaded: await rows(
              connection,
              "select extension_name, loaded from duckdb_extensions() where extension_name in ('azure', 'icu') order by 1",
            ),
          };
        },
        ":memory:",
        extensions,
      );
    })();
  },
  { official: "ok", skip: OFFLINE, timeout: 180_000 },
);
