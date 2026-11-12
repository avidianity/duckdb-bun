// Native memory pressure (docs/adr/0007-native-memory-pressure-requests-garbage-collection.md): results
// and data chunks created without an explicit destroy make the binding ask for a collection.

import { expect, test } from "bun:test";
import * as db from "../../src/bindings/api/database.ts";
import * as q from "../../src/bindings/api/query.ts";
import { diagnostics } from "../../src/bindings/runtime/diagnostics.ts";
import { MIN_PRESSURE_LIMIT, pressureState } from "../../src/bindings/runtime/handle.ts";
import { DuckDBInstance } from "../../src/neo.ts";

test("explicitly destroyed results add no pressure", async () => {
  const database = await db.open();
  const connection = await db.connect(database);
  const before = pressureState();
  for (let i = 0; i < 2 * MIN_PRESSURE_LIMIT; i++) q.destroy_result_sync(await q.query(connection, "SELECT 1"));
  expect(pressureState()).toEqual(before);
  db.disconnect_sync(connection);
  db.close_sync(database);
});

test("held results request a collection every limit, and the limit grows with the live count", async () => {
  const database = await db.open();
  const connection = await db.connect(database);
  const held = [];
  // Reach a request first, so the count starts at zero.
  while (pressureState().count !== 0 || held.length === 0) held.push(await q.query(connection, "SELECT 1"));
  const { limit } = pressureState();
  for (let i = 1; i < limit; i++) {
    held.push(await q.query(connection, "SELECT 1"));
    expect(pressureState().count).toBe(i);
  }
  held.push(await q.query(connection, "SELECT 1"));
  expect(pressureState().count).toBe(0);
  expect(pressureState().limit).toBeGreaterThanOrEqual(Math.max(MIN_PRESSURE_LIMIT, held.length));
  for (const result of held) q.destroy_result_sync(result);
  db.disconnect_sync(connection);
  db.close_sync(database);
});

test("a loop of small queries holds under two limits of unreachable results", async () => {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run("CREATE TABLE t AS SELECT i AS id, 'n' || i AS name FROM range(1000) t(i)");
  const statement = await connection.prepare("SELECT id, name FROM t WHERE id = $1");
  let most = 0;
  for (let i = 0; i < 4000; i++) {
    statement.bindInteger(1, i % 1000);
    (await statement.runAndReadAll()).getRows();
    most = Math.max(most, diagnostics().liveHandles.result ?? 0);
  }
  // With the requests about 335 were live at most on an Apple M5 Mac; without them, 922.
  expect(most).toBeLessThan(2 * MIN_PRESSURE_LIMIT);
  statement.destroySync();
  connection.closeSync();
  instance.closeSync();
});
