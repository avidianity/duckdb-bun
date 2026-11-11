// Builds the Rust shim in native/ for the host platform and copies it into the
// host's platform package (packages/duckdb-bun-<platform>/), next to libduckdb.
// Run `bun run fetch-lib` first: the shim links against that libduckdb.
//
//   bun run build:native
//
// The build sets DUCKDB_LIB_DIR to the platform package, so libduckdb-sys links
// dynamically to the shipped libduckdb with no download. The shim gets an rpath
// of its own directory (@loader_path on macOS, $ORIGIN on Linux; see
// native/build.rs), so it loads the libduckdb beside it.
//
// Tests: `cargo test --manifest-path native/Cargo.toml`. native/build.rs uses
// DUCKDB_LIB_DIR when set and the host's platform package otherwise, and gives
// the test binaries an absolute rpath to that directory, so they need no
// DYLD_LIBRARY_PATH or LD_LIBRARY_PATH.
//
// There is no cross build: each platform builds on its own runner. The
// linux-x64 release build runs in the rust:1.99.1-bookworm image (ADR 0003).
import { join } from "node:path";
import { $ } from "bun";

/** The shim file name per platform package. */
const SHIM_FILES: Record<string, string> = {
  "darwin-arm64": "libduckdb_bun_shim.dylib",
  "linux-x64": "libduckdb_bun_shim.so",
};

const ROOT = join(import.meta.dir, "..");

async function buildNative(): Promise<void> {
  const platform = `${process.platform}-${process.arch}`;
  const shimFile = SHIM_FILES[platform];
  if (!shimFile) {
    throw new Error(`No platform package for ${platform}. Known: ${Object.keys(SHIM_FILES).join(", ")}`);
  }
  const packageDir = join(ROOT, "packages", `duckdb-bun-${platform}`);
  const manifest = join(ROOT, "native", "Cargo.toml");

  await $`cargo build --release --manifest-path ${manifest}`.env({
    ...process.env,
    DUCKDB_LIB_DIR: packageDir,
  });

  const built = join(ROOT, "native", "target", "release", shimFile);
  const destination = join(packageDir, shimFile);
  await Bun.write(destination, Bun.file(built));
  console.log(`Built ${shimFile} -> packages/duckdb-bun-${platform}/`);
}

if (import.meta.main) {
  await buildNative();
}
