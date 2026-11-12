# Maintaining duckdb-bun

This document holds the procedures for upgrading DuckDB, releasing, publishing to npm, and adding a platform.
`CONTRIBUTING.md` holds the rules for every change, and `docs/adr/` holds the decisions behind the layout.

## Packages and versions

The repository publishes four npm packages:

| Package                            | Directory                          | Contents                                         |
| ---------------------------------- | ---------------------------------- | ------------------------------------------------ |
| `@avidian/duckdb-bun`              | `.`                                | the TypeScript API and bindings                  |
| `@avidian/duckdb-bun-linux-x64`    | `packages/duckdb-bun-linux-x64`    | `libduckdb.so` and `libduckdb_bun_shim.so`       |
| `@avidian/duckdb-bun-linux-arm64`  | `packages/duckdb-bun-linux-arm64`  | `libduckdb.so` and `libduckdb_bun_shim.so`       |
| `@avidian/duckdb-bun-darwin-arm64` | `packages/duckdb-bun-darwin-arm64` | `libduckdb.dylib` and `libduckdb_bun_shim.dylib` |

The main package lists each platform package in `optionalDependencies`, the way `@duckdb/node-api` ships its native addon.

The packages share one stable semantic version, independent of DuckDB's (ADR 0004):

- Minor: a DuckDB upgrade, minor or patch, that keeps the API.
- Patch: a fix of our own between DuckDB releases.
- Major: an API break.

Never publish a prerelease: `^1.0.0` ranges skip one.
The `Versions` table in `README.md` maps each package version to the DuckDB it bundles and the `@duckdb/node-api` reference it was compared against, or `none`; add a row in every release.
These versions must agree:

- `DUCKDB_VERSION` in `src/version.ts`, the one DuckDB pin.
- `version` in `package.json` and in each `packages/*/package.json`, a stable `x.y.z`.
- The row for that version in the `README.md` `Versions` table.
- Each platform package's entry in `optionalDependencies` in `package.json`.
- The `@duckdb/node-api` entry in `devDependencies`, the reference that parity, fuzz and the bench compare against (ADR 0009).
  It wraps the pinned DuckDB, or an older one while npm has none built on the pin; never a newer one.
  The Versions row names it, or `none` when it wraps an older DuckDB.
- The `libduckdb-sys` dependency in `native/Cargo.toml`, which must declare the same DuckDB C API.

## Checking versions

```sh
bun run check-version
```

It exits with status 1 when a version above disagrees, when the package version is not a stable `x.y.z`, or when this platform's package lacks `libduckdb` or the shim.
It also prints the latest DuckDB release and the latest `@duckdb/node-api` on npm; a newer upstream release never fails it.
`bun run check-version --tag v1.0.0` also requires every package version to equal the tag.
`bun run check-version --publish` also requires every platform package to hold its native files and to list them in `files`.
CI runs the plain form, and the release workflow runs the other two.

The `upstream-check` workflow runs every Monday.
When the latest DuckDB release is newer than the pin, it opens an upgrade pull request, as [Upgrading DuckDB](#upgrading-duckdb) describes; a DuckDB release never waits for a `@duckdb/node-api` (ADR 0009).
When DuckDB is current but npm has a `@duckdb/node-api` built on the pinned DuckDB that is newer than the reference pin, it opens a pull request that moves the reference.
When either run fails, it opens one issue for that target instead of a pull request.
It never opens a second issue with the same title, or a second pull request for the same target, even after the first is closed.

## Upgrading DuckDB

### The upgrade pull request

An upgrade follows DuckDB core alone: the DuckDB release assets for libduckdb and `duckdb.h`, DuckDB's C API spec for the generated FFI code, and our own suites.
The `upstream-check` workflow upgrades on its own once DuckDB publishes a release newer than the pin.
It runs `bun run upgrade-duckdb --duckdb <new>` with a read-only token, which does steps 1 to 5 of the manual procedure below.
When npm already has a `@duckdb/node-api` built on the new DuckDB, the script pins the newest one as the reference; otherwise the reference stays, and the pull request says so.
It then pushes the branch `upgrade/duckdb-<new>`, dispatches `ci.yml` on it, and opens a pull request.
A pull request that only moves the reference uses the branch `upgrade/node-api-<version>`.
GitHub starts no `pull_request` run without approval for a pull request that `GITHUB_TOKEN` opened, but a `workflow_dispatch` event always creates a run, so the dispatched run is the pull request's CI.
The pull request links that run.
The workflow needs the repository setting "Allow GitHub Actions to create and approve pull requests", under Settings, Actions, General, Workflow permissions.

To land the pull request:

1. Wait for the dispatched CI run; it runs the API and bindings suites, parity, the bench gate, and every other check.
   When npm has no `@duckdb/node-api` built on the new DuckDB, parity and fuzz report that they have nothing to compare against, and the bench gate compares against the previous release of this package; the release goes ahead.
2. Do what the pull request lists under "Left for a human", such as steps 4 and 6 below, and push to the branch, which starts CI as usual.
3. Merge it with CI green, and release the version it set, as [Releasing](#releasing) describes from step 3.

### By hand

Upgrade by hand when the workflow opened an issue instead, or to try a release before the workflow runs.
`bun run upgrade-duckdb` does steps 1 to 5, and `--dry-run` checks the target and prints its plan without writing anything.

1. Set `DUCKDB_VERSION` in `src/version.ts`.
2. When npm has a `@duckdb/node-api` built on the new DuckDB, pin the newest one as the reference with `bun add --dev --exact @duckdb/node-api@<new>-r.<n>`; otherwise keep the pin.
3. Run `bun run fetch-lib all`, `bun run vendor:api-spec` and `bun run gen:ffi`.
4. Set `libduckdb-sys` in `native/Cargo.toml` to the newest `1.<MAJOR><MINOR><PATCH>.x` release, the duckdb-rs scheme in which DuckDB 2.0.1 is `1.20001.x`, and run `cargo update --manifest-path native/Cargo.toml --package libduckdb-sys --precise <version>`.
   When crates.io has no such release yet, keep the old one and repeat this step once duckdb-rs publishes it.
   Dependabot ignores that crate for this reason.
5. Release as the next minor version (ADR 0004): set it in every `package.json` and in `optionalDependencies`, run `bun install`, and add its row to the `README.md` `Versions` table, with the reference or `none`, and its opening sentence.
   When the table already has a row for the new DuckDB, keep that row's version.
6. Read `git diff vendor/duckdb.h` for changes to functions that `src/bindings/` or `native/` call.
   Update both sides and `native/ABI.md` together.
   Port new C API surface that the API should expose: the function in `src/bindings/node-bindings.d.ts` and `src/bindings/`, then its use in `src/api/`, with tests in `tests/bindings/` and `tests/api/` (ADR 0009).
7. Run `bun run build:native` and every check from the CI workflow, in its order.
8. Commit with a message such as `build(deps): upgrade DuckDB to v2.1.0`.

## Releasing

1. Set the new version in every `package.json` and in `optionalDependencies`, add its row to the `README.md` `Versions` table, and run `bun run check-version`.
   Bump the minor version for a DuckDB upgrade, the patch version for a fix of our own, and the major version for an API break.
2. Merge to `main` with CI green.
3. Publish a GitHub release whose tag is `v` followed by the version, such as `gh release create v1.0.1 --generate-notes`.

The `Release` workflow (`.github/workflows/release.yml`) then:

1. Builds the linux-x64 shim on `ubuntu-latest` and the linux-arm64 shim on `ubuntu-24.04-arm`, both in the `rust:1.99.1-bookworm` image, and the darwin-arm64 shim on `macos-latest`, runs every test suite on each, and uploads each platform package directory.
2. Checks that every version equals the tag and that each platform package holds and lists its native files.
3. Publishes the three platform packages, then the main package, with the `latest` dist-tag and a provenance statement.

A version that is already on npm is skipped, so a failed run can be re-run.
To rebuild a tag without a new release, run the workflow by hand with `gh workflow run release.yml -f tag=v1.0.1`.

## Publishing to npm

The release workflow publishes through npm trusted publishing: npm trusts an OIDC token from the workflow run, so no npm token is stored in the repository.
Trusted publishing also attaches a provenance statement to each version.
The workflow uses `npm publish` because trusted publishing needs the npm CLI; it is the only place the project runs npm or Node.

Configure each of the four packages once, on npmjs.com, under the package's settings, in the Trusted Publisher section:

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
   It downloads every platform package from the green run into a worktree at the tag, packs the four tarballs, and checks their files, versions, `repository.url`, library architectures and the glibc floor of every Linux library.
   After you type `publish`, it runs `bun publish --access public --tag latest` for each package not yet on npm, platform packages first.
   npm asks for two-factor authentication in the terminal or the browser.
4. Revoke the token if you made one, and configure the trusted publisher of each package as above.
5. Within 2 days, release the next patch version through the release workflow, which validates the four configurations.

That first version has no provenance statement, because `bun publish` cannot generate one.

## Adding a platform

1. Add the platform to `TARGETS` in `scripts/fetch-lib.ts`, to `SHIM_FILES` in `scripts/build-native.ts`, and to the platform match in `native/build.rs`.
2. Copy a platform package directory to `packages/duckdb-bun-<platform>/`, and set `name`, `description`, `repository.directory`, `os`, `cpu`, `libc` and `files` for the new libraries.
3. Add the package to `optionalDependencies` and run `bun install`, then add its branch to `platformPackage()` and its name to `SUPPORTED` in `src/library.ts`.
4. Add a row to the platform table in `README.md` and to the table in [Packages and versions](#packages-and-versions).
   `tests/platform-packages.test.ts` fails until steps 1 to 4 agree.
5. Add the platform to the CI test matrix, add a build job to the release workflow and to the `needs` of its publish job, and publish the package before the main package.
   `scripts/first-publish.ts` reads the platforms from `TARGETS`; add the new CPU to `scripts/native-file.ts` if it is not there yet.
6. Record the change in an ADR, because the published package layout is hard to reverse.
7. Publish the package's first version by hand, as [Publishing to npm](#publishing-to-npm) describes, and configure its trusted publisher.
   The script skips the packages already on npm.

## Dependency updates

Dependabot proposes weekly updates for GitHub Actions, the Bun dependencies, and the Rust crate in `native/`.
It ignores `@duckdb/node-api` and `libduckdb-sys`, which move with a DuckDB upgrade, and `@types/bun`, which moves with the Bun pin.
Bun is pinned in `package.json` (`engines`, `packageManager`, and `@types/bun`); every workflow reads it from `packageManager` through `setup-bun`'s `bun-version-file`.
Change the Bun pin, the `oven/bun` image digest in `.github/workflows/ci.yml`, and `@types/bun` together.
A Worker frees its native work in a Node-API cleanup hook that Bun runs before it destroys the Worker's VM (ADR 0008).
That order is Bun's behavior, not a documented contract: on a Bun upgrade, re-read `VirtualMachine::on_exit` and `teardown` in Bun's source at the new tag, and run `bun run test:worker-terminate`.
Rust is pinned in `rust-toolchain.toml`, and the `rust` image tag and digest in the workflows must match it.
The `asan` job in `.github/workflows/ci.yml` alone uses a dated nightly Rust, `NIGHTLY`, for `-Zsanitizer=address`; move it to a newer date when it stops building, independently of the stable pin.
Pin each image by the digest of its multi-platform index, which `docker buildx imagetools inspect <image>:<tag>` prints first, not by one platform's manifest.
The linux-x64 and linux-arm64 jobs pull the same reference, and each runner takes its own architecture from the index.

## When something breaks

| Symptom                                                    | Likely cause                                                                          | Where to look                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `tests/version.test.ts` fails                              | the fetched `libduckdb` is not the pinned version                                     | run `bun run fetch-lib`                                                                      |
| `bun run check-version` reports a disagreement             | a version was bumped in one place only                                                | the list in [Packages and versions](#packages-and-versions)                                  |
| a query diverges in `bun run parity`                       | a value or error differs from the official binding                                    | `src/api/`, `src/bindings/`                                                                  |
| `bun run fuzz` fails                                       | a generated case differs from the official packages                                   | the printed replay command, then `src/bindings/`                                             |
| `dlopen` reports an undefined symbol                       | a C function the shim or the bindings call changed                                    | `vendor/duckdb.h`, `native/ABI.md`, `src/bindings/ffi.ts`                                    |
| a process prints `[duckdb-bun] fatal signal`               | a native crash; the report lists the last binding events                              | `native/ABI.md`, then the ring entries in the report                                         |
| the docker smoke job fails while the test job passes       | a file missing from a package's `files`, or a glibc mismatch                          | `packages/*/package.json`, the `rust` image in the workflows                                 |
| the release publish job fails with an authentication error | the trusted publisher on npmjs.com does not match the workflow                        | [Publishing to npm](#publishing-to-npm)                                                      |
| the nightly `Soak` workflow fails a check                  | memory growth, a handle leak, a stalled event loop, or a wrong answer under long load | the `soak-linux-x64` artifact, then `SOAK_SEED=<seed> bun run soak` (CONTRIBUTING.md "Soak") |
| the `asan` job reports an AddressSanitizer error           | a memory error in the shim                                                            | the stack in the report, `native/src/`                                                       |
| the `asan` job fails to build                              | the dated nightly no longer builds the shim or its standard library                   | move `NIGHTLY` in `.github/workflows/ci.yml` to a newer date                                 |
