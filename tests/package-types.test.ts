// The published declarations (ADR 0010): a strict consumer's type checker reads dist/*.d.ts through the "types"
// condition, never this package's source, and finds the @duckdb/node-api names it imports.
//
// The consumer (tests/smoke/consumer-types.ts, with tests/smoke/tsconfig.consumer.json) gets this package as it
// would from npm, resolved by name through package.json "exports", with skipLibCheck off. CI's docker smoke job
// runs the same check against the packed tarball.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildTypes, type Manifest, typesEntries } from "../scripts/build-types.ts";

const ROOT = join(import.meta.dir, "..");
const SMOKE = join(ROOT, "tests", "smoke");

let scratch = "";
let pkg = "";
let consumer = "";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "duckdb-bun-types-"));
  consumer = join(scratch, "consumer");
  // The package as npm would unpack it: its manifest, its source, and the declarations built for it.
  pkg = join(consumer, "node_modules", "@avidian", "duckdb-bun");
  await buildTypes(join(pkg, "dist"));
  await Bun.write(join(pkg, "package.json"), Bun.file(join(ROOT, "package.json")));
  await symlink(join(ROOT, "src"), join(pkg, "src"));
  const bunTypes = dirname(
    Bun.resolveSync("bun-types/package.json", dirname(Bun.resolveSync("@types/bun/package.json", ROOT))),
  );
  await symlink(bunTypes, join(consumer, "node_modules", "bun-types"));
  await Bun.write(join(consumer, "package.json"), `${JSON.stringify({ name: "consumer", type: "module" })}\n`);
  await Bun.write(join(consumer, "tsconfig.json"), Bun.file(join(SMOKE, "tsconfig.consumer.json")));
  await Bun.write(join(consumer, "consumer-types.ts"), Bun.file(join(SMOKE, "consumer-types.ts")));
}, 60_000);

afterAll(async () => {
  if (scratch !== "") await rm(scratch, { recursive: true, force: true });
});

function check(...flags: string[]): { exitCode: number; output: string } {
  const run = Bun.spawnSync([process.execPath, "check", "--no-pretty", ...flags, "-p", consumer], { cwd: consumer });
  return { exitCode: run.exitCode, output: `${run.stdout.toString()}${run.stderr.toString()}` };
}

describe("published declarations", () => {
  test("every export names a types file, and the build writes each one", async () => {
    const manifest = (await Bun.file(join(ROOT, "package.json")).json()) as Manifest;
    expect(typesEntries(manifest)).toEqual(["dist/index.d.ts", "dist/neo.d.ts"]);
    for (const entry of typesEntries(manifest)) expect(await Bun.file(join(pkg, entry)).exists()).toBe(true);
    // Hand-written declarations are copied: tsc does not.
    expect(await Bun.file(join(pkg, "dist", "bindings", "node-bindings.d.ts")).exists()).toBe(true);
  });

  test("a strict consumer type-checks with no error", () => {
    const { exitCode, output } = check();
    expect(output).not.toMatch(/error TS\d+/);
    expect(output).toMatch(/No type errors in \d+ files/);
    expect(exitCode).toBe(0);
  }, 60_000);

  test("the check reads the declarations, never the package source", () => {
    const files = check("--listFiles").output.split("\n");
    expect(files.some((file) => file.endsWith("/@avidian/duckdb-bun/dist/neo.d.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("/@avidian/duckdb-bun/dist/index.d.ts"))).toBe(true);
    expect(files.filter((file) => file.includes("/@avidian/duckdb-bun/src/"))).toEqual([]);
  }, 60_000);
});

test("typesEntries reads the types field and each export's types condition, once each", () => {
  expect(
    typesEntries({
      types: "dist/neo.d.ts",
      exports: { ".": { types: "./dist/neo.d.ts", default: "./src/neo.ts" }, "./plain": "./src/plain.ts" },
    }),
  ).toEqual(["dist/neo.d.ts"]);
  expect(typesEntries({})).toEqual([]);
});

test("the typescript that writes the declarations is the version bun check matches", async () => {
  const manifest = (await Bun.file(join(ROOT, "package.json")).json()) as { devDependencies: Record<string, string> };
  expect(process.versions.typescript).toBeString();
  expect(manifest.devDependencies.typescript).toBe(String(process.versions.typescript));
});
