// Every platform package is wired up in each place that names it (MAINTENANCE.md, "Adding a platform"):
// fetch-lib's TARGETS, the package directory and its manifest, the main package's optionalDependencies,
// the loader in src/library.ts, the shim build in scripts/build-native.ts and native/build.rs, and the
// README platform table. A platform this machine cannot run is checked here, before CI runs it.
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { SHIM_FILES } from "../scripts/build-native.ts";
import { TARGETS } from "../scripts/fetch-lib.ts";

const ROOT = join(import.meta.dir, "..");

type Manifest = {
  name: string;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  files?: string[];
  repository?: { directory?: string };
  optionalDependencies?: Record<string, string>;
};

const read = (path: string) => Bun.file(join(ROOT, path)).text();
const manifest = async (dir: string) => JSON.parse(await read(join(dir, "package.json"))) as Manifest;

const platforms = Object.keys(TARGETS);

test("the package directories are exactly the fetch-lib targets", () => {
  const dirs = readdirSync(join(ROOT, "packages")).filter((name) => name.startsWith("duckdb-bun-"));
  expect(dirs.sort()).toEqual(platforms.map((platform) => `duckdb-bun-${platform}`).sort());
});

test("the shim build knows exactly the fetch-lib targets", () => {
  expect(Object.keys(SHIM_FILES).sort()).toEqual([...platforms].sort());
});

describe.each(platforms)("%s", (platform) => {
  const [os, arch] = platform.split("-") as [string, string];
  const name = `@avidian/duckdb-bun-${platform}`;
  const dir = join("packages", `duckdb-bun-${platform}`);
  const lib = TARGETS[platform]?.lib as string;
  const shim = SHIM_FILES[platform] as string;

  test("its manifest names the platform npm installs it on", async () => {
    const pkg = await manifest(dir);
    expect(pkg.name).toBe(name);
    expect(pkg.os).toEqual([os]);
    expect(pkg.cpu).toEqual([arch]);
    expect(pkg.libc).toEqual(os === "linux" ? ["glibc"] : undefined);
    expect(pkg.repository?.directory).toBe(dir);
  });

  test("it lists and imports libduckdb and the shim", async () => {
    expect(shim.slice(shim.lastIndexOf("."))).toBe(lib.slice(lib.lastIndexOf(".")));
    expect((await manifest(dir)).files?.sort()).toEqual(["LICENSE", "index.ts", lib, shim].sort());
    const index = await read(join(dir, "index.ts"));
    expect(index).toContain(`from "./${lib}" with { type: "file" }`);
    expect(index).toContain(`from "./${shim}" with { type: "file" }`);
  });

  test("the main package depends on it", async () => {
    expect((await manifest(".")).optionalDependencies).toHaveProperty([name]);
  });

  test("the loader maps the platform to it", async () => {
    const library = await read("src/library.ts");
    expect(library).toContain(
      `if (process.platform === "${os}" && process.arch === "${arch}") {\n` +
        `    return load("${name}", () => require("${name}"));`,
    );
    expect(library).toContain(os === "linux" ? `${platform} (glibc)` : platform);
  });

  test("native/build.rs finds its libduckdb", async () => {
    const rustOs = { darwin: "macos", linux: "linux" }[os];
    const rustArch = { arm64: "aarch64", x64: "x86_64" }[arch];
    expect(await read("native/build.rs")).toContain(`("${rustOs}", "${rustArch}") => "${platform}",`);
  });

  test("the README lists it", async () => {
    expect(await read("README.md")).toMatch(new RegExp(`^\\| .+ \\| \`${name}\` \\|$`, "m"));
  });
});
