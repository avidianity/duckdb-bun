// Property-based value conversion parity: random tables of random DuckDB types,
// nested to three levels with NULLs at every level, go through every path a user
// has to write or read a value. Each case runs against the official
// `@duckdb/node-api` (on its N-API binding) and against ours, and the two outcomes,
// values or errors, must be equal as plain data (tests/parity/harness.ts `normalize`).
//
// Paths: SQL literals read back through every reader accessor; prepared
// statements bound with bind() with explicit and inferred types, with bindValue(),
// and with the typed bind* methods; the appender with appendValue(), the typed
// append* methods, and appendDataChunk(); data chunks written and read back
// directly; scalar and table function callbacks; and the value constructors.
//
// Run settings and replaying a failure: tests/fuzz/config.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  DuckDBAppender,
  DuckDBConnection,
  DuckDBInstance,
  DuckDBPreparedStatement,
  DuckDBResultReader,
  DuckDBType,
  DuckDBValue,
} from "@duckdb/node-api";
import * as official from "@duckdb/node-api";
import fc from "fast-check";
import * as oursApi from "../../src/neo.ts";
import { capture, normalize } from "../parity/harness.ts";
import { HAS_REFERENCE, NO_REFERENCE } from "../reference.ts";
import {
  ALL_KINDS,
  apiType,
  apiValue,
  caseArb,
  type FuzzCase,
  type FuzzType,
  kindsOf,
  type Raw,
  sqlLiteral,
  sqlType,
  staleAfterWrite,
  typeArb,
} from "./arbitraries.ts";
import { check, RUNS, SEED, trace } from "./config.ts";

type Api = typeof official;
type Impl = "official" | "ours";
const APIS: Record<Impl, Api> = { official, ours: oursApi as unknown as Api };

type Scenario = (api: Api, connection: DuckDBConnection) => Promise<unknown>;

const connections = new Map<Impl, { instance: DuckDBInstance; connection: DuckDBConnection }>();

beforeAll(async () => {
  if (!HAS_REFERENCE) return;
  for (const impl of ["official", "ours"] as const) {
    const instance = await APIS[impl].DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    await connection.run("SET TimeZone = 'UTC'");
    connections.set(impl, { instance, connection });
  }
});

if (!HAS_REFERENCE) console.warn(`tests/fuzz/values.test.ts: fuzz parity skipped: ${NO_REFERENCE}`);

afterAll(() => {
  for (const { instance, connection } of connections.values()) {
    connection.closeSync();
    instance.closeSync();
  }
});

/** Cases the running property tried, and how many of them the official package ran without any error. */
const tally = { cases: 0, clean: 0 };

/** Runs `scenario` on both implementations and requires equal outcomes. */
async function differential(fuzzCase: FuzzCase, scenario: Scenario): Promise<void> {
  const outcomes: Record<string, unknown> = {};
  for (const impl of ["official", "ours"] as const) {
    trace(impl, fuzzCase);
    const { connection } = connections.get(impl) as { connection: DuckDBConnection };
    outcomes[impl] = normalize(await capture(() => scenario(APIS[impl], connection)));
  }
  tally.cases++;
  if (!JSON.stringify(outcomes.official).includes('"error":')) tally.clean++;
  expect(outcomes.ours).toEqual(outcomes.official);
}

/**
 * Registers a property as a test. Errors are compared like values, so a scenario
 * that fails on both sides alike would pass while testing nothing; the test also
 * requires the official package to run a share of the cases without any error.
 */
function fuzz<T>(name: string, property: fc.IAsyncProperty<T>, options: { weight?: number; minClean?: number } = {}) {
  const { weight = 1, minClean = 0.2 } = options;
  test(
    name,
    async () => {
      tally.cases = 0;
      tally.clean = 0;
      await check(name, property, weight);
      console.log(`${name}: ${tally.cases} cases, ${tally.clean} without an error`);
      expect(tally.clean).toBeGreaterThanOrEqual(Math.floor(tally.cases * minClean));
    },
    Math.max(60_000, RUNS * weight * 1_000),
  );
}

const nameCounters = new Map<Api, number>();
/** A table or function name no earlier case used; both implementations get the same sequence. */
function freshName(api: Api, prefix: string): string {
  const next = (nameCounters.get(api) ?? 0) + 1;
  nameCounters.set(api, next);
  return `${prefix}_${next}`;
}

const columnNames = (fuzzCase: FuzzCase) => fuzzCase.types.map((_, i) => `c${i}`);

/** Every reader accessor, each captured on its own so one failure does not hide the others. */
async function readEveryWay(reader: DuckDBResultReader) {
  return {
    types: reader.columnTypes().map((type) => ({ string: type.toString(), json: type.toJson() })),
    getRows: await capture(() => reader.getRows()),
    getRowObjects: await capture(() => reader.getRowObjects()),
    getRowsJson: await capture(() => reader.getRowsJson()),
    getRowObjectsJson: await capture(() => reader.getRowObjectsJson()),
    getRowsJS: await capture(() => reader.getRowsJS()),
    getColumns: await capture(() => reader.getColumns()),
    getColumnsJson: await capture(() => reader.getColumnsJson()),
    getColumnsObjectJS: await capture(() => reader.getColumnsObjectJS()),
  };
}

/** `SELECT` of the case's rows as SQL literals, one VALUES row per row. */
function valuesQuery(fuzzCase: FuzzCase): string {
  const rows = fuzzCase.rows.map((row) => `(${row.map((raw, i) => sqlLiteral(fuzzCase.types[i], raw)).join(", ")})`);
  return `SELECT * FROM (VALUES ${rows.join(", ")}) t(${columnNames(fuzzCase).join(", ")})`;
}

async function createTable(api: Api, connection: DuckDBConnection, fuzzCase: FuzzCase): Promise<string> {
  const table = freshName(api, "fuzz_table");
  const columns = fuzzCase.types.map((type, i) => `c${i} ${sqlType(type)}`);
  await connection.run(`CREATE TABLE ${table} (${columns.join(", ")})`);
  return table;
}

/** Reads a table back with every accessor and drops it. */
async function readTable(connection: DuckDBConnection, table: string) {
  try {
    return await readEveryWay(await connection.runAndReadAll(`SELECT * FROM ${table}`));
  } finally {
    await connection.run(`DROP TABLE ${table}`);
  }
}

/** Kinds whose typed bind* and append* methods take the type as well as the value. */
const TAKES_TYPE = new Set(["ENUM", "LIST", "ARRAY", "STRUCT", "MAP", "UNION"]);

/** The typed method for each kind, as `bind<Name>` and `append<Name>`; TIME_NS and GEOMETRY have none. */
const TYPED_METHOD: Partial<Record<FuzzType["kind"], string>> = {
  BOOLEAN: "Boolean",
  TINYINT: "TinyInt",
  SMALLINT: "SmallInt",
  INTEGER: "Integer",
  BIGINT: "BigInt",
  UTINYINT: "UTinyInt",
  USMALLINT: "USmallInt",
  UINTEGER: "UInteger",
  UBIGINT: "UBigInt",
  HUGEINT: "HugeInt",
  UHUGEINT: "UHugeInt",
  BIGNUM: "BigNum",
  FLOAT: "Float",
  DOUBLE: "Double",
  VARCHAR: "Varchar",
  BLOB: "Blob",
  DATE: "Date",
  TIME: "Time",
  TIMETZ: "TimeTZ",
  TIMESTAMP: "Timestamp",
  TIMESTAMPTZ: "TimestampTZ",
  TIMESTAMPTZ_NS: "TimestampTZNanoseconds",
  TIMESTAMP_S: "TimestampSeconds",
  TIMESTAMP_MS: "TimestampMilliseconds",
  TIMESTAMP_NS: "TimestampNanoseconds",
  INTERVAL: "Interval",
  UUID: "UUID",
  BIT: "Bit",
  DECIMAL: "Decimal",
  ENUM: "Enum",
  LIST: "List",
  ARRAY: "Array",
  STRUCT: "Struct",
  MAP: "Map",
  UNION: "Union",
  VARIANT: "Variant",
};

/**
 * The arguments, after any parameter index, of the typed method for `type`, or
 * undefined when it has none. bindBlob and appendBlob take bytes, not a blob value.
 */
function typedArguments(api: Api, type: FuzzType, raw: Raw): unknown[] {
  const value = type.kind === "BLOB" && raw !== null ? raw : apiValue(api, type, raw);
  return TAKES_TYPE.has(type.kind) ? [value, apiType(api, type)] : [value];
}

/** Binds one value with the typed bind* method for its type, or bindValue() where there is none. */
function bindTyped(prepared: DuckDBPreparedStatement, index: number, api: Api, type: FuzzType, raw: Raw): void {
  const method = TYPED_METHOD[type.kind];
  if (raw === null) prepared.bindNull(index);
  else if (method === undefined) prepared.bindValue(index, apiValue(api, type, raw), apiType(api, type));
  else {
    const bind = prepared[`bind${method}` as keyof DuckDBPreparedStatement] as (...args: unknown[]) => void;
    bind.call(prepared, index, ...typedArguments(api, type, raw));
  }
}

/** Appends one value with the typed append* method for its type, or appendValue() where there is none. */
function appendTyped(appender: DuckDBAppender, api: Api, type: FuzzType, raw: Raw): void {
  const method = TYPED_METHOD[type.kind];
  if (raw === null) appender.appendNull();
  else if (method === undefined) appender.appendValue(apiValue(api, type, raw), apiType(api, type));
  else {
    const append = appender[`append${method}` as keyof DuckDBAppender] as (...args: unknown[]) => void;
    append.call(appender, ...typedArguments(api, type, raw));
  }
}

const rowValues = (api: Api, fuzzCase: FuzzCase, row: Raw[]): DuckDBValue[] =>
  row.map((raw, i) => apiValue(api, fuzzCase.types[i], raw));
const caseTypes = (api: Api, fuzzCase: FuzzCase): DuckDBType[] => fuzzCase.types.map((type) => apiType(api, type));

/** Prepares `SELECT $1 AS c0, ...`, binds each row with `bind`, and reads every result. */
function preparedScenario(bind: (prepared: DuckDBPreparedStatement, api: Api, row: Raw[]) => void, fuzzCase: FuzzCase) {
  return async (api: Api, connection: DuckDBConnection) => {
    const params = fuzzCase.types.map((_, i) => `$${i + 1} AS c${i}`);
    const prepared = await connection.prepare(`SELECT ${params.join(", ")}`);
    try {
      const results = [];
      for (const row of fuzzCase.rows) {
        results.push(
          await capture(async () => {
            bind(prepared, api, row);
            return readEveryWay(await prepared.runAndReadAll());
          }),
        );
      }
      return results;
    } finally {
      // Destroy now, not in a finalizer: destroying a prepared statement takes its
      // connection's lock, and a finalizer that runs while a later case's query
      // waits on a function callback deadlocks both implementations.
      prepared.destroySync();
    }
  };
}

/** Creates a table of the case's types, appends with `append`, and reads it back. */
function appenderScenario(
  append: (appender: DuckDBAppender, api: Api, fuzzCase: FuzzCase) => void,
  fuzzCase: FuzzCase,
) {
  return async (api: Api, connection: DuckDBConnection) => {
    const table = await createTable(api, connection, fuzzCase);
    const appended = await capture(async () => {
      const appender = await connection.createAppender(table);
      try {
        append(appender, api, fuzzCase);
        appender.flushSync();
      } finally {
        appender.closeSync();
      }
    });
    return { appended, table: await readTable(connection, table) };
  };
}

const cases = caseArb(3);

describe.skipIf(!HAS_REFERENCE)("value conversion parity, fuzzed", () => {
  fuzz(
    "SQL literals read back through every accessor",
    fc.asyncProperty(cases, (fuzzCase) =>
      differential(fuzzCase, async (_api, connection) =>
        readEveryWay(await connection.runAndReadAll(valuesQuery(fuzzCase))),
      ),
    ),
    { weight: 2 },
  );

  fuzz(
    "bind() with explicit types",
    fc.asyncProperty(cases, (fuzzCase) =>
      differential(
        fuzzCase,
        preparedScenario(
          (prepared, api, row) => prepared.bind(rowValues(api, fuzzCase, row), caseTypes(api, fuzzCase)),
          fuzzCase,
        ),
      ),
    ),
  );

  fuzz(
    "bind() with inferred types",
    fc.asyncProperty(cases, (fuzzCase) =>
      differential(
        fuzzCase,
        preparedScenario((prepared, api, row) => prepared.bind(rowValues(api, fuzzCase, row)), fuzzCase),
      ),
    ),
  );

  fuzz(
    "bindValue() and the typed bind methods",
    fc.asyncProperty(cases, fc.boolean(), (fuzzCase, typed) =>
      differential(
        fuzzCase,
        preparedScenario((prepared, api, row) => {
          prepared.clearBindings();
          row.forEach((raw, i) => {
            const type = fuzzCase.types[i];
            if (typed) bindTyped(prepared, i + 1, api, type, raw);
            else prepared.bindValue(i + 1, apiValue(api, type, raw), apiType(api, type));
          });
        }, fuzzCase),
      ),
    ),
  );

  fuzz(
    "appender appendValue() and the typed append methods",
    fc.asyncProperty(cases, fc.boolean(), (fuzzCase, typed) =>
      differential(
        fuzzCase,
        appenderScenario((appender, api) => {
          for (const row of fuzzCase.rows) {
            row.forEach((raw, i) => {
              const type = fuzzCase.types[i];
              if (typed) appendTyped(appender, api, type, raw);
              else appender.appendValue(apiValue(api, type, raw), apiType(api, type));
            });
            appender.endRow();
          }
        }, fuzzCase),
      ),
    ),
  );

  fuzz(
    "data chunks written, read back, and appended",
    fc.asyncProperty(cases, (fuzzCase) =>
      differential(fuzzCase, async (api, connection) => {
        const write = await capture(() => {
          const chunk = api.DuckDBDataChunk.create(caseTypes(api, fuzzCase), fuzzCase.rows.length);
          chunk.setRows(fuzzCase.rows.map((row) => rowValues(api, fuzzCase, row)));
          return chunk;
        });
        if (!("ok" in write)) return { write };
        const chunk = write.ok as official.DuckDBDataChunk;
        // Reading the written chunk back is broken upstream for some types; see staleAfterWrite.
        const direct = fuzzCase.types.some(staleAfterWrite)
          ? "skipped"
          : await capture(() => ({ rows: chunk.getRows(), columns: chunk.getColumns() }));
        const appended = await appenderScenario((appender) => appender.appendDataChunk(chunk), fuzzCase)(
          api,
          connection,
        );
        return { direct, appended };
      }),
    ),
  );

  fuzz(
    "scalar function callbacks echo their input",
    fc.asyncProperty(cases, (fuzzCase) =>
      differential(fuzzCase, async (api, connection) => {
        const names = fuzzCase.types.map((type) => {
          const name = freshName(api, "fuzz_echo");
          const t = apiType(api, type);
          connection.registerScalarFunction(
            api.DuckDBScalarFunction.create({
              name,
              returnType: t,
              parameterTypes: [t],
              specialHandling: true, // NULL input reaches the callback
              mainFunction: (_info, input, output) => {
                const column = input.getColumnVector(0);
                for (let row = 0; row < input.rowCount; row++) output.setItem(row, column.getItem(row));
                output.flush();
              },
            }),
          );
          return name;
        });
        const calls = names.map((name, i) => `${name}(c${i}) AS c${i}`);
        return readEveryWay(
          await connection.runAndReadAll(`SELECT ${calls.join(", ")} FROM (${valuesQuery(fuzzCase)})`),
        );
      }),
    ),
  );

  fuzz(
    "table function callbacks write every row",
    fc.asyncProperty(cases, (fuzzCase) =>
      differential(fuzzCase, async (api, connection) => {
        const name = freshName(api, "fuzz_rows");
        const types = caseTypes(api, fuzzCase);
        connection.registerTableFunction(
          api.DuckDBTableFunction.create({
            name,
            bindFunction: (info) => {
              for (const [i, type] of types.entries()) info.addResultColumn(`c${i}`, type);
            },
            initFunction: (info) => info.setInitData({ done: false }),
            mainFunction: (info, output) => {
              const state = info.initData as { done: boolean };
              if (state.done) {
                output.rowCount = 0;
                return;
              }
              state.done = true;
              output.rowCount = fuzzCase.rows.length;
              types.forEach((_, i) => {
                const column = output.getColumnVector(i);
                for (const [r, row] of fuzzCase.rows.entries())
                  column.setItem(r, apiValue(api, fuzzCase.types[i], row[i]));
                column.flush();
              });
            },
          }),
        );
        return readEveryWay(await connection.runAndReadAll(`SELECT * FROM ${name}()`));
      }),
    ),
  );

  fuzz(
    "value constructors",
    fc.asyncProperty(cases, (fuzzCase) =>
      differential(fuzzCase, async (api) =>
        Promise.all(
          fuzzCase.rows.map((row) =>
            Promise.all(
              row.map((raw, i) =>
                capture(() => {
                  const value = apiValue(api, fuzzCase.types[i], raw);
                  return { value, string: String(value), type: apiType(api, fuzzCase.types[i]).toString() };
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  test("the generator reaches every type kind", () => {
    const seen = new Set(fc.sample(typeArb(3), { numRuns: 2000, seed: SEED }).flatMap(kindsOf));
    expect(ALL_KINDS.filter((kind) => !seen.has(kind))).toEqual([]);
  });
});
