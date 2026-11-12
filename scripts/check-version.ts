// Checks that every version in this repository agrees with the DuckDB pin, and reports newer upstream releases.
//
//   bun run check-version                    consistency, then the upstream report; exits 1 on an inconsistency
//   bun run check-version --tag v1.0.0       also: every package version equals the release tag
//   bun run check-version --publish          also: every platform package holds its native files and lists
//                                            them in "files", so npm publishes them (release workflow)
//   bun run check-version --upstream-json    only the upstream report, as JSON (upstream-check workflow),
//                                            with the upgrade it should open a pull request for
//                                            (scripts/upgrade-plan.ts, upgradeTarget);
//                                            exits 1 when upstream cannot be reached
//
// A newer upstream release is informational; it never fails the default mode.
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { DUCKDB_VERSION, DUCKDB_VERSION_TAG } from "../src/version.ts";
import { TARGETS } from "./fetch-lib.ts";
import { referenceFor, upgradeTarget, versionRows } from "./upgrade-plan.ts";

const ROOT = join(import.meta.dir, "..");
const NODE_API = "@duckdb/node-api";
const SHIM_BASENAME = "libduckdb_bun_shim";

type PackageJson = {
  name?: string;
  version?: string;
  files?: string[];
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/**
 * `duckdb` compares the pin with the latest DuckDB release. `nodeApi.reference` is the newest @duckdb/node-api
 * built on the DuckDB that `upgrade` targets, or on the pin when nothing is newer, or null when npm has none.
 * `upgrade` is what the upstream-check workflow opens an upgrade pull request for: a newer DuckDB release, which
 * never waits for its @duckdb/node-api, or else a newer reference for the pinned DuckDB; null when neither exists.
 */
type UpstreamReport = {
  duckdb: { pinned: string; latest: string; newer: boolean; url: string };
  nodeApi: { pinned: string; reference: string | null; url: string | null };
  upgrade: { duckdb: string; nodeApi: string | null } | null;
};

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    tag: { type: "string" },
    publish: { type: "boolean", default: false },
    "upstream-json": { type: "boolean", default: false },
  },
  strict: true,
});

async function readPackage(dir: string): Promise<PackageJson> {
  return (await Bun.file(join(ROOT, dir, "package.json")).json()) as PackageJson;
}

/** The base DuckDB version of a `@duckdb/node-api` version, `<duckdb>-r.<n>`, or undefined for another shape. */
function duckdbBase(version: string | undefined): string | undefined {
  return /^(\d+\.\d+\.\d+)-r\.\d+$/.exec(version ?? "")?.[1];
}

/** A stable semver version: our packages never publish a prerelease, so `^1` ranges match every release. */
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The README's "Versions" table, which maps each package version to the DuckDB it bundles and the
 * `@duckdb/node-api` it matches, as rows of [package, duckdb, nodeApi].
 */
/** The native files a platform package ships: libduckdb and the shim built from native/. */
function nativeFiles(platform: string): string[] {
  const target = TARGETS[platform];
  if (!target) throw new Error(`Unknown platform ${platform}`);
  return [target.lib, `${SHIM_BASENAME}${extname(target.lib)}`];
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status} ${response.statusText}`);
  return response.json();
}

async function latestDuckDB(): Promise<string> {
  // GITHUB_TOKEN lifts the unauthenticated rate limit that shared CI runners hit.
  const token = process.env.GITHUB_TOKEN;
  const json = (await getJson("https://api.github.com/repos/duckdb/duckdb/releases/latest", {
    "User-Agent": "duckdb-bun-check-version",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  })) as { tag_name?: string };
  if (!json.tag_name) throw new Error("The latest DuckDB release has no tag_name");
  return json.tag_name.replace(/^v/, "");
}

/** Every version of @duckdb/node-api on npm. */
async function nodeApiVersions(): Promise<string[]> {
  const json = (await getJson(`https://registry.npmjs.org/${NODE_API.replace("/", "%2f")}`)) as {
    versions?: Record<string, unknown>;
  };
  return Object.keys(json.versions ?? {});
}

async function upstreamReport(nodeApiPin: string): Promise<UpstreamReport> {
  const [duckdb, versions] = await Promise.all([latestDuckDB(), nodeApiVersions()]);
  const upgrade = upgradeTarget(duckdb, DUCKDB_VERSION, versions, nodeApiPin);
  const reference = referenceFor(versions, upgrade?.duckdb ?? DUCKDB_VERSION) ?? null;
  return {
    upgrade,
    duckdb: {
      pinned: DUCKDB_VERSION,
      latest: duckdb,
      newer: Bun.semver.order(duckdb, DUCKDB_VERSION) > 0,
      url: `https://github.com/duckdb/duckdb/releases/tag/v${duckdb}`,
    },
    nodeApi: {
      pinned: nodeApiPin,
      reference,
      url: reference ? `https://www.npmjs.com/package/${NODE_API}/v/${reference}` : null,
    },
  };
}

const root = await readPackage(".");
const nodeApiPin = root.devDependencies?.[NODE_API] ?? "";

if (values["upstream-json"]) {
  console.log(JSON.stringify(await upstreamReport(nodeApiPin), null, 2));
  process.exit(0);
}

const problems: string[] = [];
const platforms = Object.keys(TARGETS);
const host = `${process.platform}-${process.arch}`;

console.log(`DuckDB pin (src/version.ts):     ${DUCKDB_VERSION_TAG}`);
console.log(`package version (package.json): ${root.version}`);
console.log(`${NODE_API} devDependency:   ${nodeApiPin || "missing"}`);

if (!STABLE.test(root.version ?? "")) {
  problems.push(
    `package.json version ${root.version} is not a stable x.y.z version; the packages never publish a prerelease.`,
  );
}
const row = versionRows(await Bun.file(join(ROOT, "README.md")).text()).find(([version]) => version === root.version);
if (row?.[1] !== DUCKDB_VERSION || row?.[2] !== nodeApiPin) {
  problems.push(
    `README.md "Versions" has no row "| ${root.version} | ${DUCKDB_VERSION} | ${nodeApiPin} |" for this package version.`,
  );
}
if (duckdbBase(nodeApiPin) !== DUCKDB_VERSION) {
  problems.push(
    `${NODE_API} ${nodeApiPin || "(missing)"} is not ${DUCKDB_VERSION}-r.<n>; the parity test would compare against another DuckDB.`,
  );
}

for (const platform of platforms) {
  const dir = join("packages", `duckdb-bun-${platform}`);
  const name = `@avidian/duckdb-bun-${platform}`;
  const pkg = await readPackage(dir);
  if (pkg.name !== name) problems.push(`${dir}/package.json is named ${pkg.name}, expected ${name}.`);
  if (pkg.version !== root.version) {
    problems.push(`${dir}/package.json version ${pkg.version} differs from package.json ${root.version}.`);
  }
  const pinned = root.optionalDependencies?.[name];
  if (pinned !== root.version) {
    problems.push(`package.json optionalDependencies pins ${name} at ${pinned}, expected ${root.version}.`);
  }

  const files = nativeFiles(platform);
  const present = files.filter((file) => existsSync(join(ROOT, dir, file)));
  console.log(`${dir}: ${files.map((file) => `${file} ${present.includes(file) ? "present" : "missing"}`).join(", ")}`);
  // The host platform needs its native files for the tests; publishing needs them for every platform.
  if (values.publish || platform === host) {
    for (const file of files.filter((file) => !present.includes(file))) {
      const fix = file.startsWith(SHIM_BASENAME) ? "bun run build:native" : `bun run fetch-lib ${platform}`;
      problems.push(`${dir}/${file} is missing; run \`${fix}\`.`);
    }
  }
  if (values.publish) {
    for (const file of files.filter((file) => !pkg.files?.includes(file))) {
      problems.push(`${dir}/package.json "files" does not list ${file}, so npm would not publish it.`);
    }
  }
}
if (!platforms.includes(host)) console.log(`No platform package for this host (${host}).`);

if (values.tag !== undefined) {
  const version = values.tag.replace(/^v/, "");
  console.log(`release tag:                     ${values.tag}`);
  if (root.version !== version)
    problems.push(`package.json version ${root.version} differs from the tag ${values.tag}.`);
}

try {
  const upstream = await upstreamReport(nodeApiPin);
  console.log(`latest DuckDB release:           v${upstream.duckdb.latest}`);
  console.log(`newest ${NODE_API} on it:    ${upstream.nodeApi.reference ?? "none on npm yet"}`);
  if (upstream.upgrade) {
    const { duckdb, nodeApi } = upstream.upgrade;
    console.log(
      duckdb === DUCKDB_VERSION
        ? `${NODE_API} ${nodeApi} is a newer reference for DuckDB v${duckdb}; see MAINTENANCE.md.`
        : `DuckDB v${duckdb} is newer than the pin; see MAINTENANCE.md.`,
    );
  }
} catch (error) {
  console.log(`upstream releases:               unavailable (${error instanceof Error ? error.message : error})`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log("\nConsistent.");
