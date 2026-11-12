// Every comparison with the official package needs the official binding (tests/official-binding.ts).
import { expect, test } from "bun:test";
import { assertRealOfficialBinding, officialBindingPath } from "./official-binding.ts";

test("the official @duckdb/node-api loads its own @duckdb/node-bindings, also under the test preload", async () => {
  expect(officialBindingPath()).toMatch(/node_modules[\\/].*@duckdb[\\/]node-bindings[\\/]duckdb\.js$/);
  assertRealOfficialBinding();
  const official = await import("@duckdb/node-api");
  const instance = await official.DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  const error = await connection.run("SELECT error('probe')").catch((caught: unknown) => caught);
  expect(String((error as Error).stack)).not.toContain(`${"src"}/bindings`);
  connection.closeSync();
  instance.closeSync();
});

test("a plain bun process, as the bench and the heavy tests start, resolves it the same way", () => {
  const child = Bun.spawnSync([
    process.execPath,
    "-e",
    `import("${import.meta.dir}/official-binding.ts").then((m) => console.log(m.officialBindingPath()))`,
  ]);
  expect(child.stdout.toString()).toMatch(/node_modules[\\/].*@duckdb[\\/]node-bindings[\\/]duckdb\.js\n$/);
});
