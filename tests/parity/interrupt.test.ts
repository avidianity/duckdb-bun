// Interrupt parity: connection.interrupt() stops a running query with the same
// error as the official binding, and the connection stays usable. Every scenario
// runs isolated, because a binding that ignores the interrupt runs the long query
// to completion (minutes) instead of failing fast.
import type { DuckDBConnection } from "@duckdb/node-api";
import { capture, parityFor, withConnection } from "./harness.ts";

const parity = parityFor(import.meta.path);

const LONG_QUERY = "SELECT sum(hash(i)) AS s FROM range(5_000_000_000) t(i)";
// The official binding's text, the truth the scenarios below are compared against.
const INTERRUPTED = "INTERRUPT Error: Interrupted!";
const OPTIONS = { isolate: true, timeout: 10_000, official: "ok" } as const;

/** Calls connection.interrupt() every 10 ms until `work` settles, and records its outcome. */
async function interruptUntilSettled(connection: DuckDBConnection, work: () => Promise<unknown>) {
  const timer = setInterval(() => connection.interrupt(), 10);
  try {
    return await capture(work);
  } finally {
    clearInterval(timer);
  }
}

async function usable(connection: DuckDBConnection) {
  return (await connection.runAndReadAll("SELECT 42 AS answer")).getRowsJson();
}

parity(
  "interrupt rejects runAndReadAll and leaves the connection usable",
  (api) =>
    withConnection(api, async (connection) => ({
      outcome: await interruptUntilSettled(connection, async () =>
        (await connection.runAndReadAll(LONG_QUERY)).getRowsJson(),
      ),
      after: await usable(connection),
    })),
  OPTIONS,
);

parity(
  "interrupt rejects run",
  (api) =>
    withConnection(api, async (connection) => ({
      outcome: await interruptUntilSettled(connection, async () => (await connection.run(LONG_QUERY)).getRowsJson()),
      after: await usable(connection),
    })),
  OPTIONS,
);

parity(
  "interrupt rejects a streamed read",
  (api) =>
    withConnection(api, async (connection) => ({
      outcome: await interruptUntilSettled(connection, async () =>
        (await connection.streamAndReadAll(LONG_QUERY)).getRowsJson(),
      ),
      after: await usable(connection),
    })),
  OPTIONS,
);

parity(
  "interrupt rejects a prepared statement run",
  (api) =>
    withConnection(api, async (connection) => {
      const prepared = await connection.prepare("SELECT sum(hash(i)) AS s FROM range($n) t(i)");
      prepared.bind({ n: 5_000_000_000 });
      return {
        outcome: await interruptUntilSettled(connection, async () => (await prepared.runAndReadAll()).getRowsJson()),
        after: await usable(connection),
      };
    }),
  OPTIONS,
);

parity(
  "interrupt rejects a pending result",
  (api) =>
    withConnection(api, async (connection) => ({
      outcome: await interruptUntilSettled(connection, async () => {
        const pending = await connection.start(LONG_QUERY);
        return (await pending.readAll()).getRowsJson();
      }),
      after: await usable(connection),
    })),
  OPTIONS,
);

parity(
  "interrupting 50 short queries in a row neither hangs nor crashes",
  (api) =>
    withConnection(api, async (connection) => {
      const unexpected: unknown[] = [];
      const timer = setInterval(() => connection.interrupt(), 10);
      try {
        for (let i = 0; i < 50; i++) {
          const outcome = await capture(async () =>
            (await connection.runAndReadAll("SELECT sum(hash(i)) AS s FROM range(2_000_000) t(i)")).getRowsJson(),
          );
          // Each query either finishes or is interrupted; which one is a race.
          if ("error" in outcome && outcome.error.message !== INTERRUPTED) unexpected.push(outcome.error);
        }
      } finally {
        clearInterval(timer);
      }
      return { unexpected, after: await usable(connection) };
    }),
  { ...OPTIONS, timeout: 30_000 },
);
