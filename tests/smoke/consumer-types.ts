// A strict consumer of the published declarations (ADR 0010), type-checked against the package as npm installs
// it, by tests/package-types.test.ts and by CI's docker smoke job with tests/smoke/tsconfig.consumer.json. It
// imports the @duckdb/node-api names downstream projects use, and is never run.
import duckdb, {
  DUCKDB_VERSION,
  type DuckDBConnection,
  DuckDBInstance,
  DuckDBPendingResultState,
  type DuckDBResult,
  DuckDBTimestampValue,
  type DuckDBValue,
  diagnostics,
} from "@avidian/duckdb-bun";
import { DuckDBInstance as NativeInstance } from "@avidian/duckdb-bun/native-js";

export async function answer(): Promise<DuckDBValue[][]> {
  const instance: DuckDBInstance = await DuckDBInstance.create(":memory:");
  const connection: DuckDBConnection = await instance.connect();
  const result: DuckDBResult = await connection.run("SELECT 42 AS answer");
  const state: DuckDBPendingResultState = DuckDBPendingResultState.RESULT_READY;
  const ts: DuckDBTimestampValue = new DuckDBTimestampValue(0n);
  const version: string = DUCKDB_VERSION;
  void [state, ts, version, diagnostics().jobs.inFlight, duckdb, NativeInstance];
  return result.getRows();
}

// @ts-expect-error a name the package does not export stays an error, so the check is not vacuous.
export type Missing = typeof import("@avidian/duckdb-bun").NotAnExport;
