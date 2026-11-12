// Worker for worker-terminate-child.ts. It opens its own database and keeps native
// work in flight until its parent terminates it, or, in "end" mode, ends on its own
// with the database still open. The mode is the last argument in process.argv.
import { DuckDBInstance, DuckDBScalarFunction, INTEGER } from "../../../src/neo.ts";

declare const self: Worker;

const mode = process.argv.at(-1);
const instance = await DuckDBInstance.create(":memory:", { threads: "4" });
const connection = await instance.connect();
connection.registerScalarFunction(
  DuckDBScalarFunction.create({
    name: "js_add",
    returnType: INTEGER,
    parameterTypes: [INTEGER],
    mainFunction: (_info, input, output) => {
      const column = input.getColumnVector(0);
      for (let row = 0; row < input.rowCount; row++) output.setItem(row, (column.getItem(row) as number) + 1);
      output.flush();
    },
  }),
);
self.postMessage("ready");

if (mode === "query" || mode === "early") {
  for (;;) await connection.runAndReadAll("SELECT sum(hash(i)) FROM range(200_000_000) t(i)");
} else if (mode === "callback") {
  for (;;) await connection.runAndReadAll("SELECT sum(js_add((i % 1000)::INTEGER)) FROM range(50_000_000) t(i)");
} else if (mode === "stream") {
  for (;;) {
    const result = await connection.stream("SELECT i, hash(i) AS h, i::VARCHAR AS s FROM range(100_000_000) t(i)");
    while ((await result.fetchChunk())?.rowCount) {}
  }
} else if (mode === "end") {
  // Results, a prepared statement and the connection stay open: the Worker's end frees them.
  await connection.runAndReadAll("SELECT sum(js_add((i % 1000)::INTEGER)) FROM range(100_000) t(i)");
  await connection.prepare("SELECT 1");
  self.postMessage("done");
} else {
  throw new Error(`unknown mode ${mode}`);
}
