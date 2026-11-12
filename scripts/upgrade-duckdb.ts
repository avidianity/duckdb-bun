// Performs the mechanical part of a DuckDB upgrade (MAINTENANCE.md, "Upgrading DuckDB"):
//
//   bun run upgrade-duckdb --duckdb 2.0.1 --node-api 2.0.1-r.1 [--dry-run] [--summary <file>]
//
//  1. Checks the target: `@duckdb/node-api` <node-api> must be built on DuckDB <duckdb>, the duckdb-node-neo
//     tag v<node-api> must exist, its node-api package must carry that version, and its node-bindings must
//     download libduckdb from DuckDB v<duckdb>. It looks up the libduckdb-sys release for <duckdb> on crates.io.
//  2. Sets DUCKDB_VERSION in src/version.ts and pins the devDependency with `bun add --dev --exact`.
//  3. Runs `fetch-lib all`, `vendor:api-spec` and `gen:ffi`.
//  4. Pins libduckdb-sys in native/Cargo.toml and native/Cargo.lock, when crates.io has a release for <duckdb>.
//
// It never touches a package version: the release version is chosen at release time.
// It is idempotent: run with the current pins, it leaves the tree unchanged.
// It stops at the first unexpected state, and --dry-run does every check and prints the plan without writing.
// --summary writes what changed and what a human must still do as Markdown, for the upgrade pull request.
// Network: api.github.com and codeload.github.com, registry.npmjs.org (bun add), and crates.io.

import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { DUCKDB_VERSION } from "../src/version.ts";
import {
  type CrateVersion,
  crateMinor,
  matchingCrate,
  nodeApiBase,
  setReadmeRelease,
  upgradeVersion,
  versionRows,
} from "./upgrade-plan.ts";

const ROOT = join(import.meta.dir, "..");
const NEO_REPO = "duckdb/duckdb-node-neo";
const NODE_API = "@duckdb/node-api";
const CRATE = "libduckdb-sys";
const USER_AGENT = "duckdb-bun-upgrade (https://github.com/avidianity/duckdb-bun)";

const USAGE = `Usage: bun run upgrade-duckdb --duckdb <version> --node-api <version> [--dry-run] [--summary <file>]

  --duckdb <version>    the DuckDB release to target, such as 2.0.1
  --node-api <version>  the @duckdb/node-api release built on it, such as 2.0.1-r.1
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
if (!values.duckdb || !values["node-api"]) {
  console.error(USAGE);
  process.exit(2);
}
const duckdb = values.duckdb.replace(/^v/, "");
const nodeApi = values["node-api"];
const dryRun = values["dry-run"];

async function get(url: string, accept: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept, "User-Agent": USER_AGENT };
  // GITHUB_TOKEN lifts the unauthenticated rate limit that shared CI runners hit; only GitHub gets it.
  const token = process.env.GITHUB_TOKEN;
  if (token && new URL(url).hostname === "api.github.com") headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status} ${response.statusText}`);
  return response;
}

async function getJson<T>(url: string): Promise<T> {
  return (await (await get(url, "application/json")).json()) as T;
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

const base = nodeApiBase(nodeApi);
if (base === undefined) throw new Error(`${NODE_API} version ${nodeApi} is not <duckdb>-r.<n>`);
if (base !== duckdb) throw new Error(`${NODE_API} ${nodeApi} is built on DuckDB ${base}, not ${duckdb}`);
if (Bun.semver.order(duckdb, DUCKDB_VERSION) < 0) {
  throw new Error(`DuckDB ${duckdb} is older than the pin ${DUCKDB_VERSION}; this script only upgrades`);
}

const rootPackage = (await Bun.file(join(ROOT, "package.json")).json()) as {
  version: string;
  devDependencies?: Record<string, string>;
};
const nodeApiPin = rootPackage.devDependencies?.[NODE_API];
if (!nodeApiPin) throw new Error(`package.json has no ${NODE_API} devDependency`);
if (Bun.semver.order(nodeApi, nodeApiPin) < 0) {
  throw new Error(`${NODE_API} ${nodeApi} is older than the pin ${nodeApiPin}; this script only upgrades`);
}
// A DuckDB upgrade is a minor release (ADR 0004); a second run for the same DuckDB keeps the version it chose.
const release = upgradeVersion(
  rootPackage.version,
  versionRows(await Bun.file(join(ROOT, "README.md")).text()),
  duckdb,
);

const CARGO_TOML = join(ROOT, "native", "Cargo.toml");
const CRATE_PIN = /^(libduckdb-sys = \{ version = "=)([^"]+)(")/m;
const cratePin = CRATE_PIN.exec(await Bun.file(CARGO_TOML).text())?.[2];
if (!cratePin) throw new Error(`native/Cargo.toml has no exact ${CRATE} pin matching ${CRATE_PIN}`);

const tag = `v${nodeApi}`;
console.log(`Resolving ${NEO_REPO} ${tag}`);
const { sha } = await getJson<{ sha: string }>(`https://api.github.com/repos/${NEO_REPO}/commits/${tag}`);

const work = await mkdtemp(join(tmpdir(), "duckdb-bun-upgrade-"));
try {
  console.log(`Downloading ${NEO_REPO} at ${sha}`);
  const tarball = await (await get(`https://api.github.com/repos/${NEO_REPO}/tarball/${sha}`, "*/*")).bytes();
  await new Bun.Archive(tarball).extract(work);
  const tops = await readdir(work);
  if (tops.length !== 1 || !tops[0]) throw new Error(`The ${NEO_REPO} tarball has ${tops.length} top-level entries`);
  const upstream = join(work, tops[0]);

  const upstreamApi = (await Bun.file(join(upstream, "api/pkgs/@duckdb/node-api/package.json")).json()) as {
    version?: string;
  };
  if (upstreamApi.version !== nodeApi) {
    throw new Error(`${NEO_REPO} ${tag} holds ${NODE_API} ${upstreamApi.version}, not ${nodeApi}`);
  }
  const upstreamBindings = (await Bun.file(
    join(upstream, "bindings/pkgs/@duckdb/node-bindings/package.json"),
  ).json()) as {
    version?: string;
  };
  const bindingsVersion = upstreamBindings.version;
  if (!bindingsVersion) throw new Error(`${NEO_REPO} ${tag} has no @duckdb/node-bindings version`);
  // The bindings download libduckdb from one DuckDB release; it must be the target.
  const fetchScript = await Bun.file(join(upstream, "bindings/scripts/fetch_libduckdb.py")).text();
  const libduckdbFrom = /releases\/download\/v(\d+\.\d+\.\d+)"/.exec(fetchScript)?.[1];
  if (libduckdbFrom !== duckdb) {
    throw new Error(`${NEO_REPO} ${tag} builds @duckdb/node-bindings on DuckDB ${libduckdbFrom}, not ${duckdb}`);
  }

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
  DuckDB                 ${DUCKDB_VERSION} -> ${duckdb}
  ${NODE_API}       ${nodeApiPin} -> ${nodeApi}
  duckdb-node-neo        ${tag} (${sha}), @duckdb/node-bindings ${bindingsVersion}
  ${CRATE}          ${cratePin} -> ${crate ?? `unchanged: crates.io has no 1.${minor}.x release`}
Steps:
  1. set DUCKDB_VERSION in src/version.ts
  2. bun add --dev --exact ${NODE_API}@${nodeApi}
  3. bun run fetch-lib all, vendor:api-spec, gen:ffi
  4. ${crate ? `pin ${CRATE} =${crate} in native/Cargo.toml and cargo update native/Cargo.lock` : `leave ${CRATE}`}
  5. release as version ${release}: set it in every package.json and add its row to the README.md Versions table`);
  if (!dryRun) await apply({ crate });
} finally {
  await rm(work, { recursive: true, force: true });
}

type Plan = {
  /** The libduckdb-sys release for the target DuckDB, or undefined when crates.io has none. */
  crate: string | undefined;
};

async function apply({ crate }: Plan): Promise<void> {
  const minor = crateMinor(duckdb);
  const followUps: string[] = [];
  const changes: string[] = [];
  const watched = ["vendor/duckdb.h"];
  const before = new Map(
    await Promise.all(watched.map(async (path) => [path, await sha256(join(ROOT, path))] as const)),
  );

  // ---- 2. The DuckDB pin and the reference package ----

  step("DUCKDB_VERSION");
  await replaceOnce(
    join(ROOT, "src", "version.ts"),
    /^export const DUCKDB_VERSION = "[^"]+";$/m,
    `export const DUCKDB_VERSION = "${duckdb}";`,
  );

  step(`${NODE_API} devDependency`);
  await $`bun add --dev --exact ${NODE_API}@${nodeApi}`.cwd(ROOT);

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
    if (crate !== cratePin)
      changes.push(`\`${CRATE}\` moves from ${cratePin} to ${crate}, the release for DuckDB ${duckdb}.`);
  } else {
    console.log(`crates.io has no ${CRATE} 1.${minor}.x; native/Cargo.toml keeps ${cratePin}.`);
    followUps.push(
      `crates.io has no \`${CRATE}\` 1.${minor}.x release for DuckDB ${duckdb} yet, so \`native/Cargo.toml\` keeps ${cratePin}.` +
        ` When duckdb-rs publishes it, run \`bun run upgrade-duckdb --duckdb ${duckdb} --node-api ${nodeApi}\` again.`,
    );
  }

  // ---- 5. The package version ----

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
  await Bun.write(readme, setReadmeRelease(await Bun.file(readme).text(), release, duckdb, nodeApi));
  await $`bun install`.cwd(ROOT);
  changes.push(
    `The package version is ${release}, a minor release for the DuckDB upgrade (ADR 0004), in every \`package.json\`, \`bun.lock\` and the \`README.md\` Versions table.`,
  );

  // ---- Summary ----

  const after = new Map(
    await Promise.all(watched.map(async (path) => [path, await sha256(join(ROOT, path))] as const)),
  );
  if (before.get("vendor/duckdb.h") !== after.get("vendor/duckdb.h")) {
    followUps.push(
      "`vendor/duckdb.h` changed: read `git diff vendor/duckdb.h` for functions that `src/bindings/` or `native/` call," +
        " and update both sides and `native/ABI.md` together.",
    );
  }

  const summary = [
    `Upgrades DuckDB from v${DUCKDB_VERSION} to v${duckdb} and \`${NODE_API}\` from ${nodeApiPin} to ${nodeApi}.`,
    "",
    "## What `scripts/upgrade-duckdb.ts` changed",
    "",
    `- \`DUCKDB_VERSION\` in \`src/version.ts\` is ${duckdb}, and the \`${NODE_API}\` devDependency is pinned at ${nodeApi}.`,
    "- `vendor/duckdb.h`, `vendor/duckdb-api-spec/` and the generated FFI code are refreshed for the new DuckDB.",
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
