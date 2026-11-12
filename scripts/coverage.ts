// Measures line and function coverage of the TypeScript in src/ and of the Rust shim in native/src/, and
// fails when either is below its floor (CONTRIBUTING.md "Coverage").
//
//   bun run coverage           build an instrumented shim, run the suites, write the reports, check the floors
//   bun run coverage --check   only check the floors against the reports a previous run wrote
//
// Reports: coverage/ts/lcov.info (Bun) and coverage/rust/lcov.info (cargo-llvm-cov); a text summary of each is printed.
//
// The shim is a cdylib that the TypeScript suites load, so its coverage comes from an instrumented build that
// those suites run, as cargo-llvm-cov's "external tests" recipe describes: `cargo llvm-cov show-env` gives the
// environment that builds with -C instrument-coverage and names the profile files, `cargo build` builds the
// instrumented shim, which is copied into the platform package in place of the release build for the run, every
// process that loads it writes a .profraw file, and `cargo llvm-cov report` merges them with the profiles of
// `cargo test`. The release shim is put back afterwards. Processes that die of a signal (the crash-report suite)
// write their profile from the crash handler, under `cfg(coverage)` in native/src/diag.rs.
//
// native/src/diag.rs is also built on its own by native/diag-tests, whose `cargo test` runs its unit tests and
// crashes child processes on purpose. That crate is measured too, and its hits count for the shim's lines and
// functions in diag.rs; lines only it compiles, such as diag.rs's own tests, are left out.
//
// Requires cargo-llvm-cov and the llvm-tools rustup component (CONTRIBUTING.md "Coverage" says how to install them).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

/** Line and function floors in percent. CONTRIBUTING.md "Coverage" says how they move; never below 90. */
export const FLOORS = {
  ts: { lines: 90, functions: 90 },
  rust: { lines: 90, functions: 90 },
} as const;

const ROOT = join(import.meta.dir, "..");
const NATIVE = join(ROOT, "native");
/**
 * The instrumented build gets its own target directory. cargo-llvm-cov adds its compiler flags through a rustc
 * wrapper that cargo does not fingerprint, so instrumented artifacts in native/target would be reused by a later
 * plain `cargo test`, whose processes then write stray default_*.profraw files.
 */
const COVERAGE_TARGET = join(NATIVE, "target", "llvm-cov-target");
const OUT = join(ROOT, "coverage");
const DIAG_TESTS = join(NATIVE, "diag-tests");
const DIAG_TESTS_LCOV = join(OUT, "rust", "diag-tests.lcov");

/** Shim file names per platform package, as scripts/build-native.ts writes them. */
const SHIM_FILES: Record<string, string> = {
  "darwin-arm64": "libduckdb_bun_shim.dylib",
  "linux-x64": "libduckdb_bun_shim.so",
};

/**
 * The TypeScript suites that count, in one `bun test` process: the unit and runtime tests, the official
 * @duckdb/node-api and @duckdb/node-bindings suites, and parity. One process, because Bun's lcov reports a
 * file's function totals (FNF, FNH) without naming the functions, so two runs' function counts cannot be merged.
 * tests/compile and tests/heavy are left out of this process: they run their subjects in child processes or
 * hold timing and memory gates; the heavy suites below still run against the instrumented shim.
 * tests/fuzz is left out because each run draws a new seed, so the lines it reaches change between runs of one
 * commit.
 */
const TS_IGNORE = ["tests/heavy/**", "tests/compile/**", "tests/fuzz/**"];

/**
 * Heavy suites that run one at a time against the instrumented shim, for the native paths they reach. The
 * crash-report children die of a signal, so the shim's crash handler writes their coverage profile itself
 * (`cfg(coverage)` in native/src/diag.rs).
 */
const HEAVY = ["tests/heavy/crash-report.test.ts"];

export interface FileCoverage {
  lines: Map<number, number>;
  /** Hits per function, keyed by the line it starts on, when the report names its functions (FN, FNDA). */
  functions: Map<number, number>;
  functionsFound: number;
  functionsHit: number;
}

export interface Totals {
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
}

/** Parses an lcov file into per-file coverage, keyed by the path relative to the repository root. */
export function parseLcov(text: string, root = ROOT): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  let current: FileCoverage | undefined;
  let starts = new Map<string, number>();
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    const tag = colon < 0 ? line : line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (tag === "SF") {
      const path = value.startsWith("/") ? relative(root, value) : value;
      current = files.get(path) ?? { lines: new Map(), functions: new Map(), functionsFound: 0, functionsHit: 0 };
      files.set(path, current);
      starts = new Map();
    } else if (tag === "end_of_record") {
      current = undefined;
    } else if (current && tag === "DA") {
      const [lineNumber, hits] = value.split(",");
      const number = Number(lineNumber);
      current.lines.set(number, Math.max(current.lines.get(number) ?? 0, Number(hits)));
    } else if (current && tag === "FN") {
      const comma = value.indexOf(",");
      const start = Number(value.slice(0, comma));
      starts.set(value.slice(comma + 1), start);
      current.functions.set(start, current.functions.get(start) ?? 0);
    } else if (current && tag === "FNDA") {
      const comma = value.indexOf(",");
      const start = starts.get(value.slice(comma + 1));
      if (start !== undefined) {
        current.functions.set(start, Math.max(current.functions.get(start) ?? 0, Number(value.slice(0, comma))));
      }
    } else if (current && tag === "FNF") {
      current.functionsFound = Number(value);
    } else if (current && tag === "FNH") {
      current.functionsHit = Number(value);
    }
  }
  return files;
}

export function totals(files: Iterable<FileCoverage>): Totals {
  const sum: Totals = { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 };
  for (const file of files) {
    sum.linesFound += file.lines.size;
    for (const hits of file.lines.values()) if (hits > 0) sum.linesHit += 1;
    if (file.functions.size > 0) {
      sum.functionsFound += file.functions.size;
      for (const hits of file.functions.values()) if (hits > 0) sum.functionsHit += 1;
    } else {
      sum.functionsFound += file.functionsFound;
      sum.functionsHit += file.functionsHit;
    }
  }
  return sum;
}

/**
 * Adds the hits `other` has on lines and functions that `base` already measures, so another build of the
 * same source counts as a test of it without adding code only that build compiles, such as its own tests.
 */
export function addHits(base: Map<string, FileCoverage>, other: Map<string, FileCoverage>): void {
  for (const [path, file] of base) {
    const extra = other.get(path);
    if (!extra) continue;
    for (const [line, hits] of file.lines) file.lines.set(line, hits + (extra.lines.get(line) ?? 0));
    for (const [start, hits] of file.functions) file.functions.set(start, hits + (extra.functions.get(start) ?? 0));
  }
}

export function percent(hit: number, found: number): number {
  return found === 0 ? 100 : (100 * hit) / found;
}

function sourceFiles(dir: string, extension: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(extension) && !name.endsWith(".d.ts"))
    .map((name) => join(dir, name))
    .sort();
}

/**
 * Checks one report against its floors. Every source file under `dir` must be in the report: a file no suite
 * loads would otherwise drop out of the total instead of counting as uncovered. Declaration files (.d.ts) hold
 * no code and are not in any report.
 */
export function check(
  name: string,
  report: Map<string, FileCoverage>,
  dir: string,
  extension: string,
  floors: { lines: number; functions: number },
): string[] {
  const problems: string[] = [];
  const sources = sourceFiles(dir, extension);
  const measured = sources.flatMap((path) => {
    const file = report.get(path);
    if (!file) problems.push(`${name}: ${path} is in no coverage report; no suite loads it`);
    return file ? [[path, file] as const] : [];
  });
  const rows = measured.map(([path, file]) => {
    const t = totals([file]);
    return `  ${path.padEnd(48)} ${percent(t.linesHit, t.linesFound).toFixed(2).padStart(7)}% lines ${percent(t.functionsHit, t.functionsFound).toFixed(2).padStart(7)}% functions`;
  });
  const all = totals(measured.map(([, file]) => file));
  const lines = percent(all.linesHit, all.linesFound);
  const functions = percent(all.functionsHit, all.functionsFound);
  console.log(`${name} (${dir})`);
  for (const row of rows) console.log(row);
  console.log(
    `  ${"total".padEnd(48)} ${lines.toFixed(2).padStart(7)}% lines ${functions.toFixed(2).padStart(7)}% functions` +
      `  (${all.linesHit}/${all.linesFound} lines, ${all.functionsHit}/${all.functionsFound} functions; floor ${floors.lines}% / ${floors.functions}%)`,
  );
  if (lines < floors.lines) problems.push(`${name}: line coverage ${lines.toFixed(2)}% is below ${floors.lines}%`);
  if (functions < floors.functions) {
    problems.push(`${name}: function coverage ${functions.toFixed(2)}% is below ${floors.functions}%`);
  }
  return problems;
}

/** The environment `cargo llvm-cov show-env` sets, evaluated by sh so its quoting is the shell's own. */
async function llvmCovEnv(base: Record<string, string | undefined>): Promise<Record<string, string>> {
  const dump = await $`sh -c ${'eval "$(cargo llvm-cov show-env --sh)" && env -0'}`.cwd(NATIVE).env(base).quiet();
  const env: Record<string, string> = {};
  for (const entry of dump.stdout.toString().split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  if (!env.LLVM_PROFILE_FILE) throw new Error("cargo llvm-cov show-env did not set LLVM_PROFILE_FILE");
  return env;
}

async function measure(): Promise<void> {
  const platform = `${process.platform}-${process.arch}`;
  const shimFile = SHIM_FILES[platform];
  if (!shimFile) throw new Error(`No platform package for ${platform}. Known: ${Object.keys(SHIM_FILES).join(", ")}`);
  const packageDir = join(ROOT, "packages", `duckdb-bun-${platform}`);
  const installed = join(packageDir, shimFile);
  const saved = join(NATIVE, "target", `release-${shimFile}`);

  const env = await llvmCovEnv({ ...process.env, DUCKDB_LIB_DIR: packageDir, CARGO_TARGET_DIR: COVERAGE_TARGET });
  // The suites get only the profile file name; the rustc wrapper settings are for cargo.
  const testEnv = { ...process.env, LLVM_PROFILE_FILE: env.LLVM_PROFILE_FILE };

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "rust"), { recursive: true });
  await $`cargo llvm-cov clean --workspace`.cwd(NATIVE).env(env);
  await $`cargo build`.cwd(NATIVE).env(env);
  await $`cargo test`.cwd(NATIVE).env(env);

  const hadRelease = existsSync(installed);
  if (hadRelease) copyFileSync(installed, saved);
  copyFileSync(join(COVERAGE_TARGET, "debug", shimFile), installed);
  const failures: string[] = [];
  try {
    const ignore = TS_IGNORE.flatMap((pattern) => ["--path-ignore-patterns", pattern]);
    const ts =
      await $`bun test ${ignore} --coverage --coverage-reporter=text --coverage-reporter=lcov --coverage-dir=${join(OUT, "ts")}`
        .cwd(ROOT)
        .env(testEnv)
        .nothrow();
    if (ts.exitCode !== 0) failures.push(`the TypeScript suites exited with ${ts.exitCode}`);
    for (const suite of HEAVY) {
      const heavy = await $`bun test ./${suite}`.cwd(ROOT).env(testEnv).nothrow();
      if (heavy.exitCode !== 0) failures.push(`${suite} exited with ${heavy.exitCode}`);
    }
  } finally {
    if (hadRelease) copyFileSync(saved, installed);
    else rmSync(installed, { force: true });
  }

  const lcov = join(OUT, "rust", "lcov.info");
  await $`cargo llvm-cov report --lcov --output-path ${lcov}`.cwd(NATIVE).env(env);
  await $`cargo llvm-cov report --summary-only`.cwd(NATIVE).env(env);

  // Its own target directory, for the reason COVERAGE_TARGET gives; `cargo llvm-cov` runs `cargo test` there.
  const diagEnv = { ...process.env, CARGO_TARGET_DIR: join(DIAG_TESTS, "target", "llvm-cov-target") };
  await $`cargo llvm-cov clean --workspace`.cwd(DIAG_TESTS).env(diagEnv);
  const diag = await $`cargo llvm-cov --lcov --output-path ${DIAG_TESTS_LCOV}`.cwd(DIAG_TESTS).env(diagEnv).nothrow();
  if (diag.exitCode !== 0) failures.push(`cargo llvm-cov in native/diag-tests exited with ${diag.exitCode}`);
  if (failures.length > 0) throw new Error(`coverage: ${failures.join("; ")}`);
}

function checkReports(): void {
  const ts = parseLcov(readFileSync(join(OUT, "ts", "lcov.info"), "utf8"));
  const rust = parseLcov(readFileSync(join(OUT, "rust", "lcov.info"), "utf8"));
  addHits(rust, parseLcov(readFileSync(DIAG_TESTS_LCOV, "utf8")));
  const problems = [
    ...check("TypeScript", ts, "src", ".ts", FLOORS.ts),
    ...check("Rust shim", rust, "native/src", ".rs", FLOORS.rust),
  ];
  if (problems.length > 0) {
    for (const problem of problems) console.error(`coverage: ${problem}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { check: { type: "boolean" } } });
  if (!values.check) await measure();
  checkReports();
}
