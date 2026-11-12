# 0010 The package publishes type declarations

Status: accepted, 2026-11-13.

## Context

Up to 1.0.1 the package published only its TypeScript source, and its `types` field and `exports` pointed at `src/neo.ts`.
Bun runs that source directly, so the code worked, but a consumer's type checker then checked every file of the package under the consumer's own compiler options.
`skipLibCheck` skips only `.d.ts` files, never `.ts` files.
A downstream project with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules` and no `allowImportingTsExtensions` got 431 errors in 154 files under `node_modules/@avidian/duckdb-bun`, all in our source: `.ts` import paths (TS5097), type-only imports without `type` (TS1484), and unchecked index access (TS2532).
The code had no bug; the consumer only needed types it could read.

`bun check`, which checks this repository, does not write declarations; `tsc` does.

## Decision

The package publishes declarations in `dist/`, and a consumer's type checker reads only them.

- `bun run build:types` (`scripts/build-types.ts`) writes a `.d.ts` file for each file of `src/` with `tsc -p tsconfig.types.json`, from the `typescript` development dependency, run with Bun.
  It copies the hand-written `.d.ts` files, such as `src/bindings/node-bindings.d.ts`, which `tsc` does not, and fails when a `types` file that `package.json` names is missing.
- Each export has a `types` condition that points at `dist/`, and `default` still points at the source that Bun runs:

  ```json
  "types": "dist/neo.d.ts",
  "exports": {
    ".": { "duckdb-bun-source": "./src/neo.ts", "types": "./dist/neo.d.ts", "default": "./src/neo.ts" },
    "./native-js": { "duckdb-bun-source": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./src/index.ts" }
  }
  ```

- The `duckdb-bun-source` condition, set by `customConditions` in this repository's `tsconfig.json`, resolves the package's own name to its source here, so the repository type-checks without building `dist/` first.
- `dist/` is never committed.
  The release workflow builds it before `check-version --publish`, which fails when a `types` file is missing, and `first-publish` builds it in its worktree.
- `tests/package-types.test.ts` and CI's docker smoke job type-check `tests/smoke/consumer-types.ts` against the package as npm installs it, with the downstream project's options and `skipLibCheck` off.

## Rejected options

- Making the source compile under every consumer's options: there is no strictest set of options, and every new flag in a consumer could break the build again.
- Publishing compiled JavaScript as well: Bun runs the source as it is, and `bun build --compile` embeds it; a second copy of the code would only be another thing to keep in step.
- Generating declarations with `isolatedDeclarations` or another tool: `tsc` is the reference implementation, and `bun check` matches its version, 7.0.2.

## Consequences

A consumer's type check no longer depends on its compiler options matching ours, and is faster, because it reads declarations instead of the source.
The published file layout gains `dist/`, which consumers reach only through the `types` conditions.
A release cannot publish without declarations, and the `typescript` development dependency moves with the TypeScript version `bun check` reports.
