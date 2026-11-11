// Resolves the native assets (libduckdb + the cc shim source + duckdb.h).
//
// libduckdb comes from the optional platform package for this platform
// (@avidian/duckdb-bun-<platform>), the way @duckdb/node-api ships its native
// addon. DUCKDB_BUN_LIBRARY_PATH overrides it with a libduckdb of the same
// version, for a platform without a package.
//
// Inside a `bun build --compile` executable the assets live in Bun's virtual
// `/$bunfs/` filesystem, which TinyCC and the C-level dlopen cannot read, so
// they are copied out to a real temp dir first.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import shimSource from "../native/shim.c" with { type: "file" };
import duckdbHeader from "../vendor/duckdb.h" with { type: "file" };

export interface NativePaths {
  /** Absolute path to libduckdb for dlopen + the shim's dlsym. */
  libPath: string;
  /** Absolute path to native/shim.c for bun:ffi `cc`. */
  shimPath: string;
  /** Directory containing duckdb.h for the shim's `-I` include flag. */
  includeDir: string;
}

const PLATFORM_PACKAGES: Record<string, string> = {
  "linux-x64": "@avidian/duckdb-bun-linux-x64",
  "darwin-arm64": "@avidian/duckdb-bun-darwin-arm64",
};

async function platformLibrary(): Promise<string> {
  const override = process.env.DUCKDB_BUN_LIBRARY_PATH;
  if (override) return override;
  const key = `${process.platform}-${process.arch}`;
  const name = PLATFORM_PACKAGES[key];
  if (!name) {
    throw new Error(
      `duckdb-bun: no libduckdb package for ${key}. Set DUCKDB_BUN_LIBRARY_PATH to a libduckdb of the same DuckDB version.`,
    );
  }
  try {
    // One literal import per platform so the bundler can follow it.
    if (key === "linux-x64") return (await import("@avidian/duckdb-bun-linux-x64")).default;
    return (await import("@avidian/duckdb-bun-darwin-arm64")).default;
  } catch (cause) {
    throw new Error(
      `duckdb-bun: the optional package ${name} is not installed. Reinstall without --no-optional, or set DUCKDB_BUN_LIBRARY_PATH.`,
      { cause },
    );
  }
}

let cached: NativePaths | undefined;

export async function loadNative(): Promise<NativePaths> {
  if (cached) return cached;
  const lib = await platformLibrary();
  if (!lib.startsWith("/$bunfs/")) {
    cached = { libPath: lib, shimPath: shimSource, includeDir: dirname(duckdbHeader) };
    return cached;
  }
  const dir = mkdtempSync(join(tmpdir(), "duckdb-bun-"));
  const libPath = join(dir, basename(lib));
  const shimPath = join(dir, "shim.c");
  await Promise.all([
    Bun.write(libPath, Bun.file(lib)),
    Bun.write(shimPath, Bun.file(shimSource)),
    Bun.write(join(dir, "duckdb.h"), Bun.file(duckdbHeader)),
  ]);
  cached = { libPath, shimPath, includeDir: dir };
  return cached;
}
