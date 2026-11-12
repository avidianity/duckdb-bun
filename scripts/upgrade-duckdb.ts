// Performs the mechanical part of a DuckDB upgrade (MAINTENANCE.md, "Upgrading DuckDB"). It follows DuckDB core
// alone (ADR 0009): no step waits for a @duckdb/node-api release.
//
//   bun run upgrade-duckdb --duckdb 2.0.1 [--node-api 2.0.1-r.1] [--dry-run] [--summary <file>]
//
//  1. Checks the target: DuckDB <duckdb> must be a release no older than the pin. It looks up the newest
//     @duckdb/node-api built on <duckdb> on npm, unless --node-api names one, and the libduckdb-sys release for
//     <duckdb> on crates.io.
//  2. Sets DUCKDB_VERSION in src/version.ts. When npm has a @duckdb/node-api built on <duckdb>, pins it with
//     `bun add --dev --exact` as the reference that parity, fuzz and the bench compare against; otherwise the
//     reference pin stays, and those checks know that no reference exists for <duckdb> (MAINTENANCE.md).
//  3. Runs `fetch-lib all`, `vendor:api-spec` and `gen:ffi`, from DuckDB's own release assets and C API spec.
//  4. Pins libduckdb-sys in native/Cargo.toml and native/Cargo.lock, when crates.io has a release for <duckdb>.
//  5. For a new DuckDB, sets the release version, the next minor version (ADR 0004), in every package.json and the
//     README.md Versions table.
//
// Run with the pinned DuckDB, it refreshes only the reference: a newer @duckdb/node-api built on the pinned DuckDB.
// It is idempotent: run with the current pins, it leaves the tree unchanged.
// It stops at the first unexpected state, and --dry-run does every check and prints the plan without writing.
// --summary writes what changed and what a human must still do as Markdown, for the upgrade pull request.
// Network: api.github.com and github.com (fetch-lib, vendor:api-spec), registry.npmjs.org, and crates.io.

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { DUCKDB_VERSION } from "../src/version.ts";
import {
  type CrateVersion,
  crateMinor,
  matchingCrate,
  nodeApiBase,
  referenceFor,
  setReadmeRelease,
  upgradeVersion,
  versionRows,
} from "./upgrade-plan.ts";

const ROOT = join(import.meta.dir, "..");
const NODE_API = "@duckdb/node-api";
const CRATE = "libduckdb-sys";
const USER_AGENT = "duckdb-bun-upgrade (https://github.com/avidianity/duckdb-bun)";

const USAGE = `Usage: bun run upgrade-duckdb --duckdb <version> [--node-api <version>] [--dry-run] [--summary <file>]

  --duckdb <version>    the DuckDB release to target, such as 2.0.1
  --node-api <version>  the @duckdb/node-api reference built on it, such as 2.0.1-r.1;
                        by default the newest one on npm, or none
  --dry-run             check the target and print the plan; write nothing
  --summary <file>      write what changed and the manual follow-ups as Markdown
  --help                print this help`;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    duckdb: { type: "string" },
    "node-api": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    summary: { type: "string" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.duckdb) {
  console.error(USAGE);
  process.exit(2);
}
const duckdb = values.duckdb.replace(/^v/, "");
const dryRun = values["dry-run"];

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

async function sha256(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return createHash("sha256")
    .update(await file.bytes())
    .digest("hex");
}

/** Replaces the one match of a pattern in a file; throws when the pattern does not match exactly once. */
async function replaceOnce(path: string, pattern: RegExp, replacement: string): Promise<void> {
  const source = await Bun.file(path).text();
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const count = [...source.matchAll(global)].length;
  if (count !== 1) throw new Error(`${relative(ROOT, path)}: expected one match of ${pattern}, found ${count}`);
  const updated = source.replace(pattern, replacement);
  if (updated !== source) await Bun.write(path, updated);
}

function step(message: string): void {
  console.log(`\n== ${message}`);
}

// ---- 1. Check the target and plan, before writing anything ----

if (!/^\d+\.\d+\.\d+$/.test(duckdb))
  throw new Error(`DuckDB version ${duckdb} is not a release <major>.<minor>.<patch>`);
if (Bun.semver.order(duckdb, DUCKDB_VERSION) < 0) {
  throw new Error(`DuckDB ${duckdb} is older than the pin ${DUCKDB_VERSION}; this script only upgrades`);
}
const newDuckdb = duckdb !== DUCKDB_VERSION;

const rootPackage = (await Bun.file(join(ROOT, "package.json")).json()) as {
  version: string;
  devDependencies?: Record<string, string>;
};
const nodeApiPin = rootPackage.devDependencies?.[NODE_API];
if (!nodeApiPin) throw new Error(`package.json has no ${NODE_API} devDependency`);

let reference = values["node-api"];
if (reference === undefined) {
  console.log(`Looking up ${NODE_API} releases built on DuckDB ${duckdb} on npm`);
  const registry = await getJson<{ versions?: Record<string, unknown> }>(
    `https://registry.npmjs.org/${NODE_API.replace("/", "%2f")}`,
  );
  reference = referenceFor(Object.keys(registry.versions ?? {}), duckdb);
} else if (nodeApiBase(reference) !== duckdb) {
  throw new Error(`${NODE_API} ${reference} is not built on DuckDB ${duckdb}`);
}
// The pin moves only forward: an older reference for this DuckDB leaves it as it is.
const pinReference = reference !== undefined && Bun.semver.order(reference, nodeApiPin) > 0;
// The reference that the new release is checked against, for the Versions table.
const releaseReference = pinReference ? reference : nodeApiBase(nodeApiPin) === duckdb ? nodeApiPin : undefined;

// A DuckDB upgrade is a minor release (ADR 0004); a second run for the same DuckDB keeps the version it chose.
const release = newDuckdb
  ? upgradeVersion(rootPackage.version, versionRows(await Bun.file(join(ROOT, "README.md")).text()), duckdb)
  : undefined;

const CARGO_TOML = join(ROOT, "native", "Cargo.toml");
const CRATE_PIN = /^(libduckdb-sys = \{ version = "=)([^"]+)(")/m;
const cratePin = CRATE_PIN.exec(await Bun.file(CARGO_TOML).text())?.[2];
if (!cratePin) throw new Error(`native/Cargo.toml has no exact ${CRATE} pin matching ${CRATE_PIN}`);

const minor = crateMinor(duckdb);
console.log(`Looking up ${CRATE} 1.${minor}.x on crates.io`);
const crates = await getJson<{ versions: CrateVersion[]; meta: { next_page: string | null } }>(
  `https://crates.io/api/v1/crates/${CRATE}/versions?per_page=100`,
);
if (crates.meta.next_page !== null) throw new Error(`crates.io lists more than 100 ${CRATE} versions; page them`);
const crate = matchingCrate(crates.versions, duckdb);
if (crate && Bun.semver.order(crate, cratePin) < 0) {
  throw new Error(`${CRATE} ${crate} for DuckDB ${duckdb} is older than the pin ${cratePin}`);
}

console.log(`
Plan${dryRun ? " (dry run: nothing is written)" : ""}:
  DuckDB                     ${DUCKDB_VERSION} -> ${duckdb}
  ${NODE_API} reference ${nodeApiPin} -> ${pinReference ? reference : `unchanged: npm has no newer release built on DuckDB ${duckdb}`}
  ${CRATE}              ${cratePin} -> ${crate ?? `unchanged: crates.io has no 1.${minor}.x release`}
Steps:
  1. set DUCKDB_VERSION in src/version.ts
  2. ${pinReference ? `bun add --dev --exact ${NODE_API}@${reference}` : `leave the ${NODE_API} devDependency`}
  3. bun run fetch-lib all, vendor:api-spec, gen:ffi
  4. ${crate ? `pin ${CRATE} =${crate} in native/Cargo.toml and cargo update native/Cargo.lock` : `leave ${CRATE}`}
  5. ${release ? `release as version ${release}: set it in every package.json and add its row to the README.md Versions table` : "keep the package version: DuckDB is unchanged"}`);
if (!dryRun) await apply();

async function apply(): Promise<void> {
  const followUps: string[] = [];
  const changes: string[] = [];
  const header = join(ROOT, "vendor", "duckdb.h");
  const headerBefore = await sha256(header);

  // ---- 2. The DuckDB pin and the reference package ----

  step("DUCKDB_VERSION");
  await replaceOnce(
    join(ROOT, "src", "version.ts"),
    /^export const DUCKDB_VERSION = "[^"]+";$/m,
    `export const DUCKDB_VERSION = "${duckdb}";`,
  );

  step(`${NODE_API} devDependency`);
  if (pinReference) {
    await $`bun add --dev --exact ${NODE_API}@${reference}`.cwd(ROOT);
    changes.push(`The \`${NODE_API}\` reference moves from ${nodeApiPin} to ${reference}, built on DuckDB ${duckdb}.`);
  } else if (releaseReference === undefined) {
    console.log(`npm has no ${NODE_API} built on DuckDB ${duckdb}; the devDependency stays ${nodeApiPin}.`);
    followUps.push(
      `npm has no \`${NODE_API}\` built on DuckDB ${duckdb} yet, so the reference stays ${nodeApiPin}.` +
        " Until one is published, parity and fuzz have nothing to compare against, and the bench gate compares" +
        " against the previous release of this package (MAINTENANCE.md). The upstream-check workflow opens a" +
        " pull request that pins the reference once npm has it; the release does not wait for it.",
    );
  }

  // ---- 3. libduckdb, duckdb.h, the C API spec, and the generated code ----

  step("fetch-lib all");
  await $`bun run fetch-lib all`.cwd(ROOT);
  step("vendor:api-spec");
  await $`bun run vendor:api-spec`.cwd(ROOT);
  step("gen:ffi");
  await $`bun run gen:ffi`.cwd(ROOT);

  // ---- 4. libduckdb-sys ----

  step(CRATE);
  if (crate) {
    await replaceOnce(CARGO_TOML, CRATE_PIN, `$1${crate}$3`);
    await replaceOnce(CARGO_TOML, /^# \S+ encodes DuckDB \S+\. /m, `# ${crate} encodes DuckDB ${duckdb}. `);
    await $`cargo update --manifest-path ${CARGO_TOML} --package ${CRATE} --precise ${crate}`.cwd(ROOT);
    if (crate !== cratePin) {
      changes.push(`\`${CRATE}\` moves from ${cratePin} to ${crate}, the release for DuckDB ${duckdb}.`);
    }
  } else {
    console.log(`crates.io has no ${CRATE} 1.${minor}.x; native/Cargo.toml keeps ${cratePin}.`);
    followUps.push(
      `crates.io has no \`${CRATE}\` 1.${minor}.x release for DuckDB ${duckdb} yet, so \`native/Cargo.toml\` keeps ${cratePin}.` +
        ` The shim links the new libduckdb dynamically, and the C API keeps its old functions.` +
        ` When duckdb-rs publishes it, run \`bun run upgrade-duckdb --duckdb ${duckdb}\` again.`,
    );
  }

  // ---- 5. The package version ----

  if (release) {
    step(`Package version ${release}`);
    const platforms = (await readdir(join(ROOT, "packages"))).filter((name) => name.startsWith("duckdb-bun-"));
    for (const path of ["package.json", ...platforms.map((name) => join("packages", name, "package.json"))]) {
      await replaceOnce(join(ROOT, path), /^ {2}"version": "[^"]+",$/m, `  "version": "${release}",`);
    }
    const rootManifest = join(ROOT, "package.json");
    let manifest = await Bun.file(rootManifest).text();
    for (const name of platforms) {
      const dependency = new RegExp(`("@avidian/${name}": )"[^"]+"`);
      if (!dependency.test(manifest)) throw new Error(`package.json has no optional dependency on @avidian/${name}`);
      manifest = manifest.replace(dependency, `$1"${release}"`);
    }
    await Bun.write(rootManifest, manifest);
    const readme = join(ROOT, "README.md");
    await Bun.write(readme, setReadmeRelease(await Bun.file(readme).text(), release, duckdb, releaseReference));
    await $`bun install`.cwd(ROOT);
    changes.push(
      `The package version is ${release}, a minor release for the DuckDB upgrade (ADR 0004), in every \`package.json\`, \`bun.lock\` and the \`README.md\` Versions table.`,
    );
  }

  // ---- Summary ----

  if (headerBefore !== (await sha256(header))) {
    followUps.push(
      "`vendor/duckdb.h` changed: read `git diff vendor/duckdb.h` for functions that `src/bindings/` or `native/` call," +
        " and update both sides and `native/ABI.md` together. Port new C API surface that the API should expose:" +
        " `src/bindings/node-bindings.d.ts`, `src/bindings/`, then `src/api/`, with tests (ADR 0009).",
    );
  }

  const summary = [
    newDuckdb
      ? `Upgrades DuckDB from v${DUCKDB_VERSION} to v${duckdb}.`
      : `Moves the \`${NODE_API}\` reference from ${nodeApiPin} to ${reference}, built on the pinned DuckDB v${duckdb}.`,
    "",
    "## What `scripts/upgrade-duckdb.ts` changed",
    "",
    ...(newDuckdb
      ? [
          `- \`DUCKDB_VERSION\` in \`src/version.ts\` is ${duckdb}.`,
          "- `vendor/duckdb.h`, `vendor/duckdb-api-spec/` and the generated FFI code are refreshed from DuckDB's own release.",
        ]
      : []),
    ...changes.map((change) => `- ${change}`),
    "",
    "## Left for a human",
    "",
    ...(followUps.length > 0 ? followUps.map((followUp) => `- ${followUp}`) : ["Nothing beyond a green CI run."]),
    "",
  ].join("\n");
  console.log(`\n${summary}`);
  if (values.summary) await Bun.write(values.summary, summary);
}
