// diagnostics(), the "duckdb-bun:call" tracing channel and SQL redaction.

import { expect, test } from "bun:test";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import * as db from "../../src/bindings/api/database.ts";
import * as q from "../../src/bindings/api/query.ts";
import { diagnostics } from "../../src/bindings/runtime/diagnostics.ts";
import { type CallContext, redactSql } from "../../src/bindings/runtime/trace.ts";
import { DUCKDB_VERSION_TAG } from "../../src/version.ts";

test("redactSql hides every literal of a statement that can carry credentials", () => {
  expect(redactSql("CREATE SECRET s (TYPE s3, KEY_ID 'AKIA', SECRET 'it''s')")).toBe(
    "CREATE SECRET s (TYPE s3, KEY_ID '<redacted>', SECRET '<redacted>')",
  );
  expect(redactSql("ATTACH 'host=db user=u password=p' AS pg (TYPE postgres)")).toBe(
    "ATTACH '<redacted>' AS pg (TYPE postgres)",
  );
  expect(redactSql("SET s3_secret_access_key = 'x'")).toBe("SET s3_secret_access_key = '<redacted>'");
  expect(redactSql("CREATE SECRET (TYPE azure, CONNECTION_STRING 'unterminated")).toBe(
    "CREATE SECRET (TYPE azure, CONNECTION_STRING '<redacted>'",
  );
  expect(redactSql("CREATE SECRET x (TYPE s3, SECRET $$a'b$$)")).toBe("CREATE SECRET x (TYPE s3, SECRET '<redacted>')");
  expect(redactSql("SELECT 'plain' AS s")).toBe("SELECT 'plain' AS s");
});

test("each native call publishes start and asyncEnd on the tracing channel", async () => {
  const events: string[] = [];
  const onStart = (message: unknown) => events.push(`start ${(message as CallContext).op}`);
  const onAsyncEnd = (message: unknown) => events.push(`asyncEnd ${(message as CallContext).op}`);
  const onError = (message: unknown) => events.push(`error ${(message as CallContext).op}`);
  subscribe("tracing:duckdb-bun:call:start", onStart);
  subscribe("tracing:duckdb-bun:call:asyncEnd", onAsyncEnd);
  subscribe("tracing:duckdb-bun:call:error", onError);
  try {
    const database = await db.open();
    const connection = await db.connect(database);
    q.destroy_result_sync(await q.query(connection, "SELECT 1"));
    await q.query(connection, "SELEC 1").catch(() => undefined);
    db.disconnect_sync(connection);
    db.close_sync(database);
  } finally {
    unsubscribe("tracing:duckdb-bun:call:start", onStart);
    unsubscribe("tracing:duckdb-bun:call:asyncEnd", onAsyncEnd);
    unsubscribe("tracing:duckdb-bun:call:error", onError);
  }
  expect(events).toEqual([
    "start open",
    "asyncEnd open",
    "start connect",
    "asyncEnd connect",
    "start query",
    "asyncEnd query",
    "start query",
    "error query",
    "asyncEnd query",
  ]);
});

test("diagnostics() counts native calls and the handles not yet freed", async () => {
  const before = diagnostics();
  const database = await db.open();
  const connection = await db.connect(database);
  const result = await q.query(connection, "SELECT 1");
  const during = diagnostics();
  expect(during.liveHandles.result).toBe((before.liveHandles.result ?? 0) + 1);
  expect(during.jobs.started - before.jobs.started).toBe(3);
  q.destroy_result_sync(result);
  db.disconnect_sync(connection);
  db.close_sync(database);
  const after = diagnostics();
  expect(after.liveHandles).toEqual(before.liveHandles);
  expect(after.jobs.inFlight).toBe(0);
  expect(after.nativeThreads.running).toBe(0);
  expect(after.versions.duckdb).toBe(DUCKDB_VERSION_TAG);
  expect(after.crashHandler).toBe("installed");
  expect(after.tracingChannel).toBe("duckdb-bun:call");
});
