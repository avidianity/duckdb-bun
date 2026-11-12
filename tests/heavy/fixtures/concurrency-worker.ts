// A Worker of the concurrency stress test (tests/heavy/concurrency-stress.test.ts):
// it loads the package, runs a query, a prepared statement, a streamed read and a
// scalar function that DuckDB's threads call back into this Worker, posts what it
// read, closes everything, and exits normally once its event loop is empty.
// The test never calls worker.terminate() (README "Known issues").

import { DuckDBInstance, DuckDBScalarFunction, diagnostics, INTEGER } from "../../../src/neo.ts";

declare const self: Worker;

const rows = Number(Bun.argv.at(-1));
const instance = await DuckDBInstance.create(":memory:", { threads: "1" });
const connection = await instance.connect();
connection.registerScalarFunction(
  DuckDBScalarFunction.create({
    name: "worker_inc",
    returnType: INTEGER,
    parameterTypes: [INTEGER],
    mainFunction: (_info, input, output) => {
      const vector = input.getColumnVector(0);
      for (let row = 0; row < input.rowCount; row++) output.setItem(row, (vector.getItem(row) as number) + 1);
      output.flush();
    },
  }),
);

const callback = (
  await connection.runAndReadAll(`SELECT sum(worker_inc(i::INTEGER))::BIGINT FROM range(${rows}) t(i)`)
).getRows()[0]?.[0];
const statement = await connection.prepare("SELECT $1::BIGINT * $2::BIGINT");
statement.bindBigInt(1, BigInt(rows));
statement.bindBigInt(2, 3n);
const prepared = (await statement.runAndReadAll()).getRows()[0]?.[0];
statement.destroySync();
let streamed = 0n;
for await (const chunk of await connection.stream(`SELECT i FROM range(${rows}) t(i)`)) {
  for (const [value] of chunk.getRows()) streamed += value as bigint;
}
connection.closeSync();
instance.closeSync();

self.postMessage({ callback, prepared, streamed, inFlight: diagnostics().jobs.inFlight });
