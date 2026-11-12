// The new bindings runtime (src/bindings/runtime, src/bindings/api) through the
// database and connection entry points: jobs on native threads, official error
// text, deferred destroy, and the shim's counters returning to rest.

import { toArrayBuffer } from "bun:ffi";
import { expect, test } from "bun:test";
import * as db from "../../src/bindings/api/database.ts";
import { shim } from "../../src/bindings/runtime/native.ts";

function counters(): bigint[] {
  return [...new BigUint64Array(toArrayBuffer(shim.dbs_counters() as never, 0, 64))];
}

test("open, connect and close run on native threads and leave none running", async () => {
  const before = counters();
  const config = db.create_config();
  db.set_config(config, "threads", "1");
  const database = await db.open(":memory:", config);
  const connection = await db.connect(database);
  expect(db.client_context_get_connection_id(db.connection_get_client_context(connection))).toBeGreaterThan(0);
  db.disconnect_sync(connection);
  db.close_sync(database);
  const after = counters();
  expect(after[0]).toBe(0n);
  expect(after[2] - before[2]).toBe(2n);
  expect(after[3] - before[3]).toBe(2n);
});

test("errors carry DuckDB's text and the official fallback messages", async () => {
  await expect(db.open("/nonexistent-duckdb-bun-dir/x.db")).rejects.toThrow(/^IO Error: Cannot open file/);
  const database = await db.open();
  db.close_sync(database);
  await expect(db.connect(database)).rejects.toStrictEqual(new Error("Failed to connect: instance closed"));
  expect(() => db.set_config(database as never, "threads", "1")).toThrow(new Error("Invalid config argument"));
  expect(() => db.get_config_flag(1e6)).toThrow(new Error("Config option not found"));
});

test("close_sync while connect is in flight waits for it", async () => {
  const database = await db.open();
  const pending = db.connect(database);
  db.close_sync(database);
  const connection = await pending;
  expect(connection).toBeDefined();
  db.disconnect_sync(connection);
});

test("config, table name, and catalog arguments take the official JavaScript types", async () => {
  const config = db.create_config();
  expect(() => db.set_config(config, 1 as never, "1")).toThrow(new TypeError("A string was expected"));
  expect(() => db.set_config(config, "threads", 1 as never)).toThrow(new TypeError("A string was expected"));
  expect(() => db.set_config(config, "threads", null as never)).toThrow(new TypeError("A string was expected"));
  // The index is read as Number::Uint32Value, so 2^32 wraps to the first flag.
  expect(db.get_config_flag(2 ** 32)).toEqual(db.get_config_flag(0));
  expect(() => db.get_config_flag("0" as never)).toThrow(new TypeError("A number was expected"));
  const database = await db.open();
  const connection = await db.connect(database);
  expect(() => db.get_table_names(connection, 1 as never, true)).toThrow(new TypeError("A string was expected"));
  expect(() => db.get_table_names(connection, "SELECT 1", 1 as never)).toThrow(new TypeError("A boolean was expected"));
  const context = db.connection_get_client_context(connection);
  expect(() => db.client_context_get_catalog(context, 1 as never)).toThrow(new TypeError("A string was expected"));
  db.disconnect_sync(connection);
  db.close_sync(database);
});
