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

| Command                  | What it proves                                                        |
| ------------------------ | --------------------------------------------------------------------- |
| `bun run check`          | Biome lint and format, then `bun check` type checking                 |
| `bun run test:official`  | the vendored `@duckdb/node-api` test suite passes on our bindings     |
| `bun run test:bindings`  | the vendored `@duckdb/node-bindings` test suite passes on our bindings |
| `bun run parity`         | results match the real `@duckdb/node-api` side by side                |
| `bun test`               | everything above plus the stress, leak, crash-report and compile tests |

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
