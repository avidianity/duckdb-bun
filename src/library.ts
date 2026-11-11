// Resolves the two native libraries: libduckdb and the Rust shim
// (libduckdb_bun_shim), both shipped in the optional platform package for this
// platform (@avidian/duckdb-bun-<platform>), the way @duckdb/node-api ships its
// native addon.
//
// Resolution is synchronous so the bindings module has no top-level await and
// stays loadable through require(), which worker_threads and CommonJS callers
// use.
//
// The shim links libduckdb and finds it beside itself through its rpath
// ($ORIGIN, @loader_path). Two cases copy both libraries side by side into a
// fresh temporary directory, so the shim and JavaScript load one and the same
// libduckdb: DUCKDB_BUN_LIBRARY_PATH, which overrides libduckdb with one of the
// same DuckDB version, and a `bun build --compile` executable, whose files live
// in Bun's virtual `/$bunfs/` filesystem that dlopen cannot read.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import shimSource from "../native/shim.c" with { type: "file" };
import duckdbHeader from "../vendor/duckdb.h" with { type: "file" };

export interface NativePaths {
  /** Absolute path to libduckdb. */
  libPath: string;
  /** Absolute path to the shim cdylib, built from native/. */
  shimPath: string;
}

interface PlatformPackage {
  default: string;
  shimPath: string;
}

const PLATFORM_PACKAGES: Record<string, string> = {
  "linux-x64": "@avidian/duckdb-bun-linux-x64",
  "darwin-arm64": "@avidian/duckdb-bun-darwin-arm64",
};

function platformPackage(): PlatformPackage {
  const key = `${process.platform}-${process.arch}`;
  const name = PLATFORM_PACKAGES[key];
  if (!name) {
    throw new Error(
      `duckdb-bun: no native package for ${key}; the supported platforms are linux-x64 and darwin-arm64.`,
    );
  }
  try {
    // One literal require per platform, so `bun build --compile` embeds it.
    if (key === "linux-x64") return require("@avidian/duckdb-bun-linux-x64") as PlatformPackage;
    return require("@avidian/duckdb-bun-darwin-arm64") as PlatformPackage;
  } catch (cause) {
    throw new Error(`duckdb-bun: the optional package ${name} is not installed. Reinstall without --no-optional.`, {
      cause,
    });
  }
}

function copyTo(dir: string, path: string, name = basename(path)): string {
  const target = join(dir, name);
  writeFileSync(target, readFileSync(path));
  return target;
}

let cached: NativePaths | undefined;

export function nativePaths(): NativePaths {
  if (cached) return cached;
  const pkg = platformPackage();
  const override = process.env.DUCKDB_BUN_LIBRARY_PATH;
  if (!override && !pkg.default.startsWith("/$bunfs/")) {
    cached = { libPath: pkg.default, shimPath: pkg.shimPath };
    return cached;
  }
  const dir = mkdtempSync(join(tmpdir(), "duckdb-bun-"));
  cached = {
    // Under the file name the shim links against, whatever the override is called.
    libPath: copyTo(dir, override || pkg.default, basename(pkg.default)),
    shimPath: copyTo(dir, pkg.shimPath),
  };
  return cached;
}

// --- legacy TinyCC loader, removed at the cutover ---------------------------------

export interface LegacyNativePaths {
  /** Absolute path to libduckdb for dlopen + the shim's dlsym. */
  libPath: string;
  /** Absolute path to native/shim.c for bun:ffi `cc`. */
  shimPath: string;
  /** Directory containing duckdb.h for the shim's `-I` include flag. */
  includeDir: string;
}

async function legacyPlatformLibrary(): Promise<string> {
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

let legacyCached: LegacyNativePaths | undefined;

/** @deprecated The TinyCC loader of the old bindings; removed at the cutover to the Rust shim. */
export async function loadNative(): Promise<LegacyNativePaths> {
  if (legacyCached) return legacyCached;
  const lib = await legacyPlatformLibrary();
  if (!lib.startsWith("/$bunfs/")) {
    legacyCached = { libPath: lib, shimPath: shimSource, includeDir: dirname(duckdbHeader) };
    return legacyCached;
  }
  const dir = mkdtempSync(join(tmpdir(), "duckdb-bun-"));
  const libPath = join(dir, basename(lib));
  const shimPath = join(dir, "shim.c");
  await Promise.all([
    Bun.write(libPath, Bun.file(lib)),
    Bun.write(shimPath, Bun.file(shimSource)),
    Bun.write(join(dir, "duckdb.h"), Bun.file(duckdbHeader)),
  ]);
  legacyCached = { libPath, shimPath, includeDir: dir };
  return legacyCached;
}
