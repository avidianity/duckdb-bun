// Performs the mechanical part of a DuckDB upgrade (MAINTENANCE.md, "Upgrading DuckDB"):
//
//   bun run upgrade-duckdb --duckdb 2.0.1 --node-api 2.0.1-r.1 [--dry-run] [--summary <file>]
//
//  1. Checks the target: `@duckdb/node-api` <node-api> must be built on DuckDB <duckdb>, the duckdb-node-neo
//     tag v<node-api> must exist, its node-api package must carry that version, and its node-bindings must
//     download libduckdb from DuckDB v<duckdb>. It looks up the libduckdb-sys release for <duckdb> on crates.io.
//  2. Sets DUCKDB_VERSION in src/version.ts and pins the devDependency with `bun add --dev --exact`.
//  3. Re-vendors duckdb-node-neo at that tag as vendor/node-api/PROVENANCE.md describes, rewrites the
//     bindings imports, updates the PROVENANCE table, and syncs the test imports in tests/official/.
//  4. Runs `fetch-lib all`, `vendor:api-spec`, `gen:ffi` and `gen:contract`.
//  5. Pins libduckdb-sys in native/Cargo.toml and native/Cargo.lock, when crates.io has a release for <duckdb>.
//
// It never touches a package version: the release version is chosen at release time.
// It is idempotent: run with the current pins, it leaves the tree unchanged.
// It stops at the first unexpected state, and --dry-run does every check and prints the plan without writing.
// --summary writes what changed and what a human must still do as Markdown, for the upgrade pull request.
// Network: api.github.com and codeload.github.com, registry.npmjs.org (bun add), and crates.io.

import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { DUCKDB_VERSION } from "../src/version.ts";

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

/** The DuckDB version a `<duckdb>-r.<n>` version is built on, or undefined for another shape. */
function nodeApiBase(version: string): string | undefined {
  return /^(\d+\.\d+\.\d+)-r\.\d+$/.exec(version)?.[1];
}

/**
 * The second component of the libduckdb-sys versions for a DuckDB version. duckdb-rs documents the scheme
 * `1.MAJOR_MINOR_PATCH.x` since DuckDB 1.5.0: DuckDB 1.5.0 is 1.10500.x and DuckDB 2.0.0 is 1.20000.x.
 */
function crateMinor(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`DuckDB version ${version} is not <major>.<minor>.<patch>`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (minor > 99 || patch > 99) throw new Error(`DuckDB ${version} does not fit the libduckdb-sys version scheme`);
  return major * 10000 + minor * 100 + patch;
}

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

/** Every file under a directory, as paths relative to it; throws on anything but files and directories. */
async function listFiles(dir: string, base = dir): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path, base)));
    else if (entry.isFile()) files.push(relative(base, path));
    else throw new Error(`${path} is neither a file nor a directory; vendoring copies only regular files`);
  }
  return files.sort();
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
  devDependencies?: Record<string, string>;
};
const nodeApiPin = rootPackage.devDependencies?.[NODE_API];
if (!nodeApiPin) throw new Error(`package.json has no ${NODE_API} devDependency`);
if (Bun.semver.order(nodeApi, nodeApiPin) < 0) {
  throw new Error(`${NODE_API} ${nodeApi} is older than the pin ${nodeApiPin}; this script only upgrades`);
}

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

  // What PROVENANCE.md "Updating" step 2 copies, as [upstream path, vendored path, directory?].
  const copies: [string, string, boolean][] = [
    ["api/src", "vendor/node-api/src", true],
    ["api/test", "vendor/node-api/test", true],
    ["bindings/test", "vendor/node-bindings/test", true],
    ["LICENSE", "vendor/node-api/LICENSE", false],
    ["LICENSE", "vendor/node-bindings/LICENSE", false],
    ["bindings/pkgs/@duckdb/node-bindings/duckdb.d.ts", "vendor/node-api/node-bindings.d.ts", false],
  ];
  for (const [from, , directory] of copies) {
    const path = join(upstream, from);
    const stat = await lstat(path).catch((error: unknown) => {
      throw new Error(`${NEO_REPO} ${tag} has no ${from}`, { cause: error });
    });
    if (directory ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`${NEO_REPO} ${tag}: ${from} is not a ${directory ? "directory" : "file"}`);
    }
    if (directory && (await listFiles(path)).length === 0) throw new Error(`${NEO_REPO} ${tag}: ${from} is empty`);
  }

  const minor = crateMinor(duckdb);
  console.log(`Looking up ${CRATE} 1.${minor}.x on crates.io`);
  const crates = await getJson<{ versions: { num: string; yanked: boolean }[]; meta: { next_page: string | null } }>(
    `https://crates.io/api/v1/crates/${CRATE}/versions?per_page=100`,
  );
  if (crates.meta.next_page !== null) throw new Error(`crates.io lists more than 100 ${CRATE} versions; page them`);
  const crate = crates.versions
    .filter((version) => !version.yanked && new RegExp(`^1\\.${minor}\\.\\d+$`).test(version.num))
    .map((version) => version.num)
    .sort((a, b) => Bun.semver.order(b, a))[0];
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
  3. re-vendor ${copies.map(([, to]) => to).join(", ")}
  4. bun run scripts/vendor-rewrite-bindings.ts, update vendor/node-api/PROVENANCE.md and tests/official/*.test.ts
  5. bun run fetch-lib all, vendor:api-spec, gen:ffi, gen:contract
  6. ${crate ? `pin ${CRATE} =${crate} in native/Cargo.toml and cargo update native/Cargo.lock` : `leave ${CRATE}`}
  7. update the version sentence in README.md`);
  if (!dryRun) await apply({ upstream, sha, bindingsVersion, crate, copies });
} finally {
  await rm(work, { recursive: true, force: true });
}

type Plan = {
  /** The extracted duckdb-node-neo tree at the tag. */
  upstream: string;
  sha: string;
  bindingsVersion: string;
  /** The libduckdb-sys release for the target DuckDB, or undefined when crates.io has none. */
  crate: string | undefined;
  copies: [string, string, boolean][];
};

async function apply({ upstream, sha, bindingsVersion, crate, copies }: Plan): Promise<void> {
  const minor = crateMinor(duckdb);
  const followUps: string[] = [];
  const changes: string[] = [];
  const watched = ["vendor/duckdb.h", "vendor/node-api/node-bindings.d.ts"];
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

  // ---- 3. Re-vendor duckdb-node-neo ----

  step(`Re-vendor ${NEO_REPO} ${tag}`);
  for (const [from, to, directory] of copies) {
    const target = join(ROOT, to);
    if (directory) {
      await rm(target, { recursive: true, force: true });
      for (const file of await listFiles(join(upstream, from))) {
        await Bun.write(join(target, file), Bun.file(join(upstream, from, file)));
      }
    } else {
      await Bun.write(target, Bun.file(join(upstream, from)));
    }
    console.log(`${from} -> ${to}`);
  }
  await $`bun run scripts/vendor-rewrite-bindings.ts`.cwd(ROOT);

  const provenance = join(ROOT, "vendor", "node-api", "PROVENANCE.md");
  const rows: [string, string][] = [
    ["Tag", `\`${tag}\``],
    ["Commit", `\`${sha}\``],
    [`\`${NODE_API}\` version`, `\`${nodeApi}\``],
    ["`@duckdb/node-bindings` version", `\`${bindingsVersion}\` (DuckDB core v${duckdb})`],
  ];
  let table = await Bun.file(provenance).text();
  for (const [label, value] of rows) {
    const lines = table.split("\n");
    const index = lines.findIndex((line) => line.split("|")[1]?.trim() === label);
    const cells = lines[index]?.split("|");
    if (cells?.length !== 4 || cells[2] === undefined) {
      throw new Error(`vendor/node-api/PROVENANCE.md has no table row "${label}"`);
    }
    cells[2] = ` ${value} `.padEnd(cells[2].length);
    lines[index] = cells.join("|");
    table = lines.join("\n");
  }
  await Bun.write(provenance, table);

  // Each official suite entrypoint imports every top-level test file of its vendored suite.
  for (const [entry, dir] of [
    ["tests/official/api.test.ts", "vendor/node-api/test"],
    ["tests/official/bindings.test.ts", "vendor/node-bindings/test"],
  ] as const) {
    const path = join(ROOT, entry);
    const prefix = `import "../../${dir}/`;
    const lines = (await Bun.file(path).text()).split("\n");
    const first = lines.findIndex((line) => line.startsWith(prefix));
    const last = lines.findLastIndex((line) => line.startsWith(prefix));
    if (first < 0) throw new Error(`${entry} imports nothing from ${dir}`);
    const block = lines.slice(first, last + 1);
    if (!block.every((line) => line.startsWith(prefix) && line.endsWith('.test.ts";'))) {
      throw new Error(`${entry}: the ${dir} imports are not one block of test file imports`);
    }
    const imported = block.map((line) => line.slice(prefix.length, -'";'.length));
    const present = (await readdir(join(ROOT, dir), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => entry.name);
    const removed = imported.filter((name) => !present.includes(name));
    const added = present.filter((name) => !imported.includes(name)).sort();
    const names = [...imported.filter((name) => present.includes(name)), ...added];
    lines.splice(first, block.length, ...names.map((name) => `${prefix}${name}";`));
    let source = lines.join("\n");
    const header = /(duckdb-node-neo\s+(?:\/\/\s+)?)v\d+\.\d+\.\d+-r\.\d+/;
    if (!header.test(source)) throw new Error(`${entry}: the header comment names no duckdb-node-neo tag`);
    source = source.replace(header, `$1${tag}`);
    await Bun.write(path, source);
    if (added.length > 0) {
      changes.push(`${entry} now imports the new upstream test files ${added.map((n) => `\`${n}\``).join(", ")}.`);
    }
    if (removed.length > 0) {
      changes.push(`${entry} no longer imports ${removed.map((n) => `\`${n}\``).join(", ")}, removed upstream.`);
    }
  }

  // ---- 4. libduckdb, duckdb.h, the C API spec, and the generated code ----

  step("fetch-lib all");
  await $`bun run fetch-lib all`.cwd(ROOT);
  step("vendor:api-spec");
  await $`bun run vendor:api-spec`.cwd(ROOT);
  step("gen:ffi");
  await $`bun run gen:ffi`.cwd(ROOT);
  step("gen:contract");
  await $`bun run gen:contract`.cwd(ROOT);

  // ---- 5. libduckdb-sys ----

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

  // ---- 6. README.md ----

  step("README.md");
  const readme = join(ROOT, "README.md");
  const sentence = /It targets DuckDB v\d+\.\d+\.\d+ and `@duckdb\/node-api` \d+\.\d+\.\d+-r\.\d+\./;
  const readmeText = await Bun.file(readme).text();
  if (sentence.test(readmeText)) {
    await Bun.write(
      readme,
      readmeText.replace(sentence, `It targets DuckDB v${duckdb} and \`${NODE_API}\` ${nodeApi}.`),
    );
  } else {
    followUps.push("`README.md` no longer has the sentence that names the targeted versions; update it by hand.");
  }

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
  if (before.get("vendor/node-api/node-bindings.d.ts") !== after.get("vendor/node-api/node-bindings.d.ts")) {
    followUps.push(
      "`vendor/node-api/node-bindings.d.ts` changed: implement new or changed binding functions in `src/bindings/`," +
        " with the official C++ binding at the new tag as the reference.",
    );
  }
  followUps.push(
    "Choose the package version at release time (MAINTENANCE.md, Releasing); this change leaves every package version alone.",
  );

  const summary = [
    `Upgrades DuckDB from v${DUCKDB_VERSION} to v${duckdb} and \`${NODE_API}\` from ${nodeApiPin} to ${nodeApi}.`,
    "",
    "## What `scripts/upgrade-duckdb.ts` changed",
    "",
    `- \`DUCKDB_VERSION\` in \`src/version.ts\` is ${duckdb}, and the \`${NODE_API}\` devDependency is pinned at ${nodeApi}.`,
    `- \`vendor/node-api\` and \`vendor/node-bindings\` are re-vendored from ${NEO_REPO} \`${tag}\` (\`${sha}\`), and the bindings imports rewritten.`,
    "- `vendor/duckdb.h`, `vendor/duckdb-api-spec/` and the generated FFI and contract code are refreshed for the new DuckDB.",
    ...changes.map((change) => `- ${change}`),
    "",
    "## Left for a human",
    "",
    ...followUps.map((followUp) => `- ${followUp}`),
    "",
  ].join("\n");
  console.log(`\n${summary}`);
  if (values.summary) await Bun.write(values.summary, summary);
}
