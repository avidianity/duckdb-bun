# Contributing to duckdb-bun

duckdb-bun is a drop-in replacement for `@duckdb/node-api` that runs on Bun through `bun:ffi`.
The rules below apply to every change, whoever or whatever writes it.
Agents read the same rules from `.rules`.

## Setup

```sh
bun install
bun run fetch-lib   # downloads libduckdb for your platform into packages/
bun test
```

Bun is pinned in `package.json` (`engines` and `packageManager`); use that version.
`bun install` installs the Git hooks through lefthook.

## Checks

| Command                    | What it proves                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `bun run check`            | Biome lint and format, then `bun check` type checking                                          |
| `bun run test:official`    | the vendored `@duckdb/node-api` test suite passes on our bindings                              |
| `bun run test:bindings`    | the vendored `@duckdb/node-bindings` test suite passes on our bindings                         |
| `bun run parity`           | results and error text match the real `@duckdb/node-api` side by side                          |
| `bun run fuzz`             | generated values of every type, and random binding calls, match the real packages side by side |
| `bun run test:concurrency` | concurrent calls of every kind and Workers stay correct and settle                             |
| `bun run soak`             | a long service-like load keeps memory, handles and the event loop steady                       |
| `bun test`                 | everything above plus the stress, leak, crash-report and compile tests                         |
| `bun run coverage`         | coverage of `src/` and the Rust shim is at or above its floors                                 |

## Fuzz

`bun run fuzz` (`tests/fuzz/`) runs property tests with a fixed seed, so a result never changes across runs of one commit.
A failure prints the command that replays it; `tests/fuzz/config.ts` lists the knobs (`FUZZ_RUNS`, `FC_SEED`, `FC_PATH`, `FUZZ_TRACE`).
CI runs it on every push, and every night at nightly length with a new seed (`bun run fuzz:nightly`), which prints its seed first.

## Concurrency stress

`bun run test:concurrency` (`tests/heavy/concurrency-stress.test.ts`) runs every kind of call on one instance at once for `STRESS_SECONDS` seconds of load, 8 by default, then waits for the job pool's idle timeout and sends calls across it.
A run takes about 12 seconds plus the load, and up to 15 seconds more on Linux, where it also checks that idle pool threads exit.
Each run prints its seed; `STRESS_SEED=<seed> bun run test:concurrency` repeats that run's choices of queries, sizes and pauses, though not the interleaving across threads.

## Soak

`bun run soak` (`scripts/soak.ts`) runs a service-like load on one long-lived instance for `--minutes` minutes, 45 by default: eight handlers send NDJSON, CSV and Parquet reads over temp files, prepared statements, `?` and `$n` parameters, streamed reads, short queries and errors, with a pause of up to 20 ms between requests.
Every `--sample-seconds` seconds, 5 by default, it records RSS, the JS heap, `diagnostics().liveHandles`, jobs in flight, running native jobs, OS and job pool threads (Linux), and event loop timer gaps.
It fails when any request gets a wrong answer or error, when RSS grows faster than `MAX_RSS_SLOPE_MIB_PER_MINUTE` (1 MiB a minute) with 99% confidence, on a least-squares line through the second half of the samples, when the p99 event loop gap reaches 50 ms, when a job is still in flight after the load, when live handles do not return to their baseline after everything is closed and collected, or, on Linux, when idle job pool threads do not exit.
It writes `soak.json` and `soak.md` to `--out` (`soak-report/` by default), and `SOAK_SEED=<seed>` repeats a run's choices.
The `Soak` workflow (`.github/workflows/soak.yml`) runs it nightly on linux-x64 and on demand with a `minutes` input from 1 to 300, and uploads the report as the `soak-linux-x64` artifact.

## AddressSanitizer

The `asan` job in `.github/workflows/ci.yml` runs the shim's cargo tests (`native/tests/*.rs`) with the shim and the standard library built with AddressSanitizer, on a dated nightly Rust.
To run it locally, set `NIGHTLY` to the toolchain the job's `NIGHTLY` names, install it with the `rust-src` component, and run, from `native/`:

```sh
rustup toolchain install "$NIGHTLY" --profile minimal --component rust-src
DUCKDB_LIB_DIR="$(pwd)/../packages/duckdb-bun-linux-x64" RUSTFLAGS=-Zsanitizer=address CARGO_TARGET_DIR=target/asan \
  ASAN_OPTIONS=detect_leaks=0 cargo "+$NIGHTLY" test -Zbuild-std --target x86_64-unknown-linux-gnu
```

On macOS, use `darwin-arm64` and `--target aarch64-apple-darwin`.
The job's comment explains why the Bun suites do not run against an ASan shim.

## Coverage

`bun run coverage` measures line and function coverage of `src/` and of the Rust shim in `native/src/`, and fails below a floor.
It builds an instrumented shim, runs `cargo test`, the unit, runtime, official, bindings and parity suites in one `bun test` process, and the crash-report suite, all against that shim.
It writes `coverage/ts/lcov.info` and `coverage/rust/lcov.info`; `bun run coverage --check` checks the floors of existing reports again.
CI runs it on linux-x64 and uploads `coverage/` as the `coverage-linux-x64` artifact.

The floors live in `FLOORS` in `scripts/coverage.ts`.
Each floor is at least 90% of lines and 90% of functions, and a floor only moves up.
No file is excluded from a report to meet a floor: every source file under `src/` and `native/src/` counts, and a file that no suite loads fails the check.
Code that only a crashing process runs is measured too: in coverage builds the crash handler writes the profile before the process dies (`native/ABI.md`, "Diagnostics").

It needs the `llvm-tools` component of the pinned Rust toolchain (`rustup component add llvm-tools`) and `cargo-llvm-cov` at the version the `coverage` job in `.github/workflows/ci.yml` installs.

## Rules

- Verify every version-specific fact about Bun, `bun:ffi`, or the DuckDB C API against the installed version's docs or source before you rely on it.
  Training data and blog posts go stale; name the source in the pull request.
- Fix behavior in `src/bindings/`, never in the vendored upstream code under `vendor/`.
  The official C++ binding is the reference for semantics and error text.
- Never block the JS thread for the length of a query, and never let a native thread touch memory the JS heap owns.
- Every behavior change ships with a test; a bug fix starts with a test that reproduces the bug through the public API.
- Do not edit a vendored test to make it pass.
- Classify a failing test before fixing it: introduced by your change, pre-existing, or environmental.
  Fix what you introduced; report the rest in an issue.
- A flaky test is a bug, not something to retry.
- Prefer a battle-tested library or the platform API over hand-rolled code, and pin every dependency to an exact version.
- Record a hard-to-reverse decision as an ADR in `docs/adr/`.
- Never skip Git hooks.

## Commits and pull requests

- Use Conventional Commits, for example `fix(bindings): free the result when fetch_chunk fails`.
- No `Co-Authored-By` lines or tool attribution in commits, pull requests, or issues.
- In Markdown, put each sentence on its own line, and do not use the em dash.

## Reporting a bug

Include your OS and architecture, `bun --version`, the package version, and a minimal SQL reproduction.
If the process crashed, include the `[duckdb-bun] fatal signal` report it printed to stderr, and the output of `diagnostics()` if you can get it.
A query that `bun run parity` shows diverging from `@duckdb/node-api` is the ideal report.
