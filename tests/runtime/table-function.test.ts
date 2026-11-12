// Table functions of the new bindings (src/bindings/api/table-function.ts):
// bind, init, local init and main callbacks share their data, parameters reach
// bind, errors from any callback fail the query, and borrowed handles die when
// the callback returns.

import { afterAll, beforeAll, expect, test } from "bun:test";
import duckdb, {
  type Connection,
  type Database,
  type DataChunk,
  type TableFunctionBindInfo,
  type TableFunctionInfo,
  type TableFunctionInitInfo,
  Type,
} from "../../src/bindings/next.ts";

let database: Database;
let connection: Connection;

beforeAll(async () => {
  const config = duckdb.create_config();
  duckdb.set_config(config, "threads", "4");
  database = await duckdb.open(":memory:", config);
  connection = await duckdb.connect(database);
});

afterAll(() => {
  duckdb.disconnect_sync(connection);
  duckdb.close_sync(database);
});

const BIGINT = () => duckdb.create_logical_type(Type.BIGINT);
const VARCHAR = () => duckdb.create_logical_type(Type.VARCHAR);

async function allRows(sql: string): Promise<bigint[]> {
  const result = await duckdb.query(connection, sql);
  const rows: bigint[] = [];
  for (;;) {
    const chunk = (await duckdb.fetch_chunk(result)) as DataChunk | null;
    if (!chunk) break;
    const size = duckdb.data_chunk_get_size(chunk);
    if (size === 0) break;
    const data = duckdb.vector_get_data(duckdb.data_chunk_get_vector(chunk, 0), size * 8);
    rows.push(...new BigInt64Array(data.buffer, 0, size));
  }
  return rows;
}

type Bind = { count: bigint; step: bigint };
type Init = { next: bigint };

function counter(name: string) {
  const table_function = duckdb.create_table_function();
  duckdb.table_function_set_name(table_function, name);
  duckdb.table_function_add_parameter(table_function, BIGINT());
  duckdb.table_function_add_named_parameter(table_function, "step", BIGINT());
  duckdb.table_function_set_extra_info(table_function, { label: name });
  // DuckDB registers a table function only with bind, init and main set.
  duckdb.table_function_set_init(table_function, () => {});
  return table_function;
}

test("bind, init, local init and main share their data through one query", async () => {
  const seen: string[] = [];
  const table_function = counter("counter");
  duckdb.table_function_set_bind(table_function, (info) => {
    expect(duckdb.bind_get_extra_info(info)).toEqual({ label: "counter" });
    expect(duckdb.bind_get_parameter_count(info)).toBe(1);
    const count = duckdb.get_int64(duckdb.bind_get_parameter(info, 0));
    const step = duckdb.bind_get_named_parameter(info, "step");
    duckdb.bind_add_result_column(info, "n", BIGINT());
    duckdb.bind_set_cardinality(info, Number(count), true);
    duckdb.bind_set_bind_data(info, { count, step: step ? duckdb.get_int64(step) : 1n } satisfies Bind);
    seen.push("bind");
  });
  duckdb.table_function_set_init(table_function, (info) => {
    expect(typeof (duckdb.init_get_bind_data(info) as Bind).count).toBe("bigint");
    expect(duckdb.init_get_column_count(info)).toBe(1);
    expect(duckdb.init_get_column_index(info, 0)).toBe(0);
    duckdb.init_set_max_threads(info, 1);
    duckdb.init_set_init_data(info, { next: 0n } satisfies Init);
    seen.push("init");
  });
  duckdb.table_function_set_local_init(table_function, (info) => {
    duckdb.init_set_init_data(info, { local: true });
    seen.push("local init");
  });
  duckdb.table_function_set_function(table_function, (info, output) => {
    expect(duckdb.function_get_extra_info(info)).toEqual({ label: "counter" });
    expect(duckdb.function_get_local_init_data(info)).toEqual({ local: true });
    const bind = duckdb.function_get_bind_data(info) as Bind;
    const state = duckdb.function_get_init_data(info) as Init;
    const rows: bigint[] = [];
    while (state.next < bind.count && rows.length < 2) rows.push(state.next++ * bind.step);
    duckdb.copy_data_to_vector(
      duckdb.data_chunk_get_vector(output, 0),
      0,
      new BigInt64Array(rows).buffer,
      0,
      rows.length * 8,
    );
    duckdb.data_chunk_set_size(output, rows.length);
  });
  duckdb.register_table_function(connection, table_function);
  duckdb.destroy_table_function_sync(table_function);

  expect(await allRows("SELECT n FROM counter(5, step = 10)")).toEqual([0n, 10n, 20n, 30n, 40n]);
  expect(seen.slice(0, 2)).toEqual(["bind", "init"]);
  expect(seen).toContain("local init");
  expect(await allRows("SELECT n FROM counter(3)")).toEqual([0n, 1n, 2n]);
});

test("an error from bind, init or main fails the query with its message", async () => {
  const bindThrows = counter("bind_throws");
  duckdb.table_function_set_bind(bindThrows, () => {
    throw new Error("my bind error");
  });
  duckdb.table_function_set_function(bindThrows, () => {});
  duckdb.register_table_function(connection, bindThrows);
  await expect(duckdb.query(connection, "SELECT * FROM bind_throws(1)")).rejects.toThrow("my bind error");

  const initThrows = counter("init_throws");
  duckdb.table_function_set_bind(initThrows, (info) => duckdb.bind_add_result_column(info, "n", BIGINT()));
  duckdb.table_function_set_init(initThrows, () => {
    throw new Error("my init error");
  });
  duckdb.table_function_set_function(initThrows, () => {});
  duckdb.register_table_function(connection, initThrows);
  await expect(duckdb.query(connection, "SELECT * FROM init_throws(1)")).rejects.toThrow("my init error");

  const mainSetsError = counter("main_sets_error");
  duckdb.table_function_set_bind(mainSetsError, (info) => duckdb.bind_add_result_column(info, "s", VARCHAR()));
  duckdb.table_function_set_function(mainSetsError, (info) => duckdb.function_set_error(info, "my main error"));
  duckdb.register_table_function(connection, mainSetsError);
  await expect(duckdb.query(connection, "SELECT * FROM main_sets_error(1)")).rejects.toThrow("my main error");
});

test("handles a callback received die when it returns", async () => {
  let saved:
    | { bind: TableFunctionBindInfo; init: TableFunctionInitInfo; info: TableFunctionInfo; output: DataChunk }
    | undefined;
  let bind: TableFunctionBindInfo | undefined;
  let init: TableFunctionInitInfo | undefined;
  const table_function = counter("keeps_handles");
  duckdb.table_function_set_bind(table_function, (info) => {
    bind = info;
    duckdb.bind_add_result_column(info, "n", BIGINT());
  });
  duckdb.table_function_set_init(table_function, (info) => {
    init = info;
  });
  duckdb.table_function_set_function(table_function, (info, output) => {
    if (bind && init) saved ??= { bind, init, info, output };
    duckdb.data_chunk_set_size(output, 0);
  });
  duckdb.register_table_function(connection, table_function);
  expect(await allRows("SELECT * FROM keeps_handles(1)")).toEqual([]);
  if (!saved) throw new Error("the function never ran");
  expect(() => duckdb.bind_get_parameter_count(saved?.bind as TableFunctionBindInfo)).toThrow(
    new Error("Invalid table function bind info argument"),
  );
  expect(() => duckdb.init_get_column_count(saved?.init as TableFunctionInitInfo)).toThrow(
    new Error("Invalid table function init info argument"),
  );
  expect(() => duckdb.function_get_bind_data(saved?.info as TableFunctionInfo)).toThrow(
    new Error("Invalid table function info argument"),
  );
  expect(() => duckdb.data_chunk_get_size(saved?.output as DataChunk)).toThrow(
    new Error("Invalid data chunk argument"),
  );
});

test("a cardinality past 2^53 saturates, and the official argument errors hold", async () => {
  const table_function = counter("huge");
  let parameterError: unknown;
  duckdb.table_function_set_bind(table_function, (info) => {
    duckdb.bind_add_result_column(info, "n", BIGINT());
    duckdb.bind_set_cardinality(info, 2 ** 70, false);
    expect(duckdb.bind_get_named_parameter(info, "missing")).toBeNull();
    try {
      duckdb.bind_get_parameter(info, 5);
    } catch (error) {
      parameterError = error;
    }
  });
  duckdb.table_function_set_function(table_function, (_info, output) => duckdb.data_chunk_set_size(output, 0));
  duckdb.register_table_function(connection, table_function);
  expect(await allRows("SELECT * FROM huge(1)")).toEqual([]);
  expect(parameterError).toEqual(new Error("Failed to get parameter"));

  const noMain = duckdb.create_table_function();
  duckdb.table_function_set_name(noMain, "no_main");
  expect(() => duckdb.register_table_function(connection, noMain)).toThrow(
    new Error("Failed to register table function"),
  );
  expect(() => duckdb.table_function_set_bind(noMain, "x" as never)).toThrow(new Error("A function was expected"));
  expect(() => duckdb.table_function_set_name(connection as never, "x")).toThrow(
    new Error("Invalid table function argument"),
  );
});
