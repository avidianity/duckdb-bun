// Downloads the prebuilt libduckdb shared library for a platform into its
// platform package (packages/duckdb-bun-<platform>/), and the matching duckdb.h
// into vendor/. The version is pinned in src/version.ts.
//
//   bun run fetch-lib                 # the host platform
//   bun run fetch-lib linux-x64       # one platform
//   bun run fetch-lib all             # every platform package
import { join } from "node:path";
import { DUCKDB_VERSION } from "../src/version.ts";

type Target = { asset: string; lib: string };

/** One entry per platform package under packages/. */
export const TARGETS: Record<string, Target> = {
  "linux-x64": { asset: "duckdb-shared-libs-linux-amd64", lib: "libduckdb.so" },
  "linux-arm64": { asset: "duckdb-shared-libs-linux-arm64", lib: "libduckdb.so" },
  "darwin-arm64": { asset: "duckdb-shared-libs-osx-arm64", lib: "libduckdb.dylib" },
};

const ROOT = join(import.meta.dir, "..");

async function fetchTarget(key: string): Promise<void> {
  const target = TARGETS[key];
  if (!target) {
    throw new Error(`Unknown target "${key}". Known: ${Object.keys(TARGETS).join(", ")}, all`);
  }
  const url = `https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/${target.asset}.tar.gz`;
  console.log(`Fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status} ${response.statusText}`);
  const files = await new Bun.Archive(await response.bytes()).files();
  const lib = files.get(target.lib);
  const header = files.get("duckdb.h");
  if (!lib || !header) throw new Error(`${url} holds no ${target.lib} or duckdb.h`);
  await Bun.write(join(ROOT, "packages", `duckdb-bun-${key}`, target.lib), lib);
  await Bun.write(join(ROOT, "vendor", "duckdb.h"), header);
  console.log(`Vendored ${target.lib} (DuckDB v${DUCKDB_VERSION}) -> packages/duckdb-bun-${key}/`);
}

if (import.meta.main) {
  const arg = process.argv[2] ?? `${process.platform}-${process.arch}`;
  for (const key of arg === "all" ? Object.keys(TARGETS) : [arg]) await fetchTarget(key);
}
