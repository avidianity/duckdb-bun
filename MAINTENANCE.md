# Maintaining duckdb-bun

This document holds the procedures for upgrading DuckDB, releasing, publishing to npm, and adding a platform.
`CONTRIBUTING.md` holds the rules for every change, and `docs/adr/` holds the decisions behind the layout.

## Packages and versions

The repository publishes three npm packages:

| Package                            | Directory                          | Contents                                         |
| ---------------------------------- | ---------------------------------- | ------------------------------------------------ |
| `@avidian/duckdb-bun`              | `.`                                | the TypeScript API and bindings                  |
| `@avidian/duckdb-bun-linux-x64`    | `packages/duckdb-bun-linux-x64`    | `libduckdb.so` and `libduckdb_bun_shim.so`       |
| `@avidian/duckdb-bun-darwin-arm64` | `packages/duckdb-bun-darwin-arm64` | `libduckdb.dylib` and `libduckdb_bun_shim.dylib` |

The main package lists each platform package in `optionalDependencies`, the way `@duckdb/node-api` ships its native addon.

Every package version is `<duckdb>-r.<n>`, the scheme `@duckdb/node-api` uses.
`2.0.0-r.0` wraps DuckDB 2.0.0, a release that keeps DuckDB bumps `<n>`, and a new DuckDB resets `<n>` to 0.
These versions must agree:

- `DUCKDB_VERSION` in `src/version.ts`, the one DuckDB pin.
- `version` in `package.json` and in each `packages/*/package.json`.
- Each platform package's entry in `optionalDependencies` in `package.json`.
- The `@duckdb/node-api` entry in `devDependencies`, which must wrap the same DuckDB, so that `bun run parity` compares like with like.
- The `libduckdb-sys` dependency in `native/Cargo.toml`, which must declare the same DuckDB C API.

## Checking versions

```sh
bun run check-version
```

It exits with status 1 when a version above disagrees, or when this platform's package lacks `libduckdb` or the shim.
It also prints the latest DuckDB release and the latest `@duckdb/node-api` on npm; a newer upstream release never fails it.
`bun run check-version --tag v2.0.0-r.0` also requires every package version to equal the tag.
`bun run check-version --publish` also requires every platform package to hold its native files and to list them in `files`.
CI runs the plain form, and the release workflow runs the other two.

The `upstream-check` workflow runs every Monday.
It opens one issue for each newer DuckDB release and each newer `@duckdb/node-api`, and never opens a second issue with the same title, even after the first is closed.
Close the issue in the change that upgrades.

## Upgrading DuckDB

1. Set `DUCKDB_VERSION` in `src/version.ts`.
2. Set the version to `<new>-r.0` in `package.json`, in each `packages/*/package.json`, and in `optionalDependencies`.
3. Pin the reference with `bun add --dev --exact @duckdb/node-api@<new>-r.<n>`.
4. Re-vendor `duckdb-node-neo` at the tag of that release, as `vendor/node-api/PROVENANCE.md` describes, and run `bun run gen:contract` when `node-bindings.d.ts` changed.
5. Set `libduckdb-sys` in `native/Cargo.toml` to the release built from the new `duckdb.h`.
   Dependabot ignores that crate for this reason.
6. Run `bun run fetch-lib all`, then read `git diff vendor/duckdb.h` for changes to functions that `src/bindings/` or `native/` call.
   Update both sides and `native/ABI.md` together.
7. Run `bun run build:native` and every check from the CI workflow, in its order.
8. Commit with a message such as `build(deps): upgrade DuckDB to v2.1.0`.

## Releasing

1. Set the new version in every `package.json` and in `optionalDependencies`, and run `bun run check-version`.
2. Merge to `main` with CI green.
3. Publish a GitHub release whose tag is `v` followed by the version, such as `gh release create v2.0.0-r.1 --generate-notes`.

The `Release` workflow (`.github/workflows/release.yml`) then:

1. Builds the linux-x64 shim in the `rust:1.99.1-bookworm` image and the darwin-arm64 shim on `macos-latest`, runs every test suite on each, and uploads each platform package directory.
2. Checks that every version equals the tag and that each platform package holds and lists its native files.
3. Publishes the two platform packages, then the main package, with the `latest` dist-tag.

A version that is already on npm is skipped, so a failed run can be re-run.
To rebuild a tag without a new release, run the workflow by hand with `gh workflow run release.yml -f tag=v2.0.0-r.1`.

## Publishing to npm

The release workflow publishes through npm trusted publishing: npm trusts an OIDC token from the workflow run, so no npm token is stored in the repository.
Trusted publishing also attaches a provenance statement to each version.
The workflow uses `npm publish` because trusted publishing needs the npm CLI; it is the only place the project runs npm or Node.

Configure each of the three packages once, on npmjs.com, under the package's settings, in the Trusted Publisher section:

- Publisher: GitHub Actions.
- Organization or user: `avidianity`.
- Repository: `duckdb-bun`.
- Workflow filename: `release.yml`.
- Environment name: `npm`, the GitHub environment the publish job uses; add required reviewers to it to gate releases.

`repository.url` in each `package.json` must match the GitHub repository exactly, so keep it when you edit a package.
npm requires a new trusted publisher configuration to complete its first successful publish within 2 days.

Trusted publishing can only be configured for a package that already exists on npm.
To publish the first version of a new package:

1. Push the tag `v<version>`, and run the release workflow without its publish job: `gh workflow run release.yml -f tag=v<version> -f publish=false`.
2. Log in to npm so that `bun pm whoami` prints your account, through `~/.npmrc` or a short-lived granular access token in `NPM_CONFIG_TOKEN`.
3. Run `bun run first-publish` (`--dry-run` first, to see the checks without publishing).
   It downloads both platform packages from the green run into a worktree at the tag, packs the three tarballs, and checks their files, versions, `repository.url`, library architectures and the linux-x64 shim's glibc floor.
   After you type `publish`, it runs `bun publish --access public --tag next` for each package not yet on npm, platform packages first.
   npm asks for two-factor authentication in the terminal or the browser.
4. Revoke the token if you made one, and configure the trusted publisher of each package as above.
5. Within 2 days, release the next version through the release workflow, which validates the three configurations and sets `latest`.

That first version has no provenance statement, because `bun publish` cannot generate one.

## Adding a platform

1. Add the platform to `TARGETS` in `scripts/fetch-lib.ts`.
2. Copy a platform package directory to `packages/duckdb-bun-<platform>/`, and set `name`, `os`, `cpu`, `libc` and `files` for the new libraries.
3. Add the package to `optionalDependencies` and to `PLATFORM_PACKAGES` and the imports in `src/library.ts`.
4. Add the platform to the CI matrix, add a build job to the release workflow, and publish the package before the main package.
5. Record the change in an ADR, because the published package layout is hard to reverse.

## Dependency updates

Dependabot proposes weekly updates for GitHub Actions, the Bun dependencies, and the Rust crate in `native/`.
It ignores `@duckdb/node-api` and `libduckdb-sys`, which move with a DuckDB upgrade, and `@types/bun`, which moves with the Bun pin.
Bun is pinned in `package.json` (`engines`, `packageManager`, and `@types/bun`); every workflow reads it from `packageManager` through `setup-bun`'s `bun-version-file`.
Change the Bun pin, the `oven/bun` image digest in `.github/workflows/ci.yml`, and `@types/bun` together.
Rust is pinned in `rust-toolchain.toml`, and the `rust` image tag and digest in the workflows must match it.

## When something breaks

| Symptom                                                    | Likely cause                                                   | Where to look                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| `tests/version.test.ts` fails                              | the fetched `libduckdb` is not the pinned version              | run `bun run fetch-lib`                                      |
| `bun run check-version` reports a disagreement             | a version was bumped in one place only                         | the list in [Packages and versions](#packages-and-versions)  |
| a query diverges in `bun run parity`                       | a value or error differs from the official binding             | `src/bindings/`                                              |
| `dlopen` reports an undefined symbol                       | a C function the shim or the bindings call changed             | `vendor/duckdb.h`, `native/ABI.md`, `src/bindings/ffi.ts`    |
| a process prints `[duckdb-bun] fatal signal`               | a native crash; the report lists the last binding events       | `native/ABI.md`, then the ring entries in the report         |
| the docker smoke job fails while the test job passes       | a file missing from a package's `files`, or a glibc mismatch   | `packages/*/package.json`, the `rust` image in the workflows |
| the release publish job fails with an authentication error | the trusted publisher on npmjs.com does not match the workflow | [Publishing to npm](#publishing-to-npm)                      |
