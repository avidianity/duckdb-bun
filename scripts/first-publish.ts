// Publishes the first version of the three packages by hand, because npm accepts a trusted publisher
// only for a package that already exists (MAINTENANCE.md, "Publishing to npm"). Every later version
// goes out through the release workflow.
//
//   bun run first-publish [--run <release workflow run id>] [--dry-run]
//
// It publishes what a green release workflow run built and tested, never a local build:
//
//  1. Finds the Release run that built the tag `v<version>` with publish off, and checks both build jobs passed.
//  2. Checks the tag out into a temporary worktree and downloads both platform packages into it.
//  3. Runs `check-version --tag --publish`, packs the three tarballs, and checks each one: its file list,
//     its package.json, the CPU architecture of every native library, and the glibc the linux-x64 shim needs.
//  4. Shows the npm account and what it will publish, and asks for confirmation.
//  5. Runs `bun publish <tarball> --access public --tag next`, platform packages first. npm asks for
//     two-factor authentication in the terminal or the browser; the script never sees it.
//  6. Waits until npm serves each version, then prints the trusted publisher settings to enter on npmjs.com.
//
// A version already on npm is skipped, so a failed run can be re-run. Auth comes from the npm config Bun
// reads (~/.npmrc, or NPM_CONFIG_TOKEN with a short-lived granular token); `bun pm whoami` must succeed.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { TARGETS } from "./fetch-lib.ts";

const REPO = "avidianity/duckdb-bun";
const REPOSITORY_URL = "git+https://github.com/avidianity/duckdb-bun.git";
const WORKFLOW = "release.yml";
const ENVIRONMENT = "npm";
const DIST_TAG = "next";
const REGISTRY = "https://registry.npmjs.org";
const SHIM = "libduckdb_bun_shim";
// The linux-x64 shim is built in rust:1.99.1-bookworm (docs/adr/0003); the README promises glibc 2.36.
const MAX_GLIBC_MINOR = 36;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { run: { type: "string" }, "dry-run": { type: "boolean", default: false } },
  strict: true,
});
const dryRun = values["dry-run"];

const ROOT = join(import.meta.dir, "..");

interface Manifest {
  name: string;
  version: string;
  repository?: { url?: string };
  optionalDependencies?: Record<string, string>;
}

interface Pkg {
  /** Directory relative to the repository root. */
  dir: string;
  platform?: string;
  name: string;
  tarball: string;
}

function fail(message: string): never {
  console.error(`\nfirst-publish: ${message}`);
  process.exit(1);
}

function step(message: string): void {
  console.log(`\n== ${message}`);
}

// --- GitHub --------------------------------------------------------------------------------

/** The avidianity token for this repository only, passed per command and never printed. */
const ghEnv = { ...process.env, GH_TOKEN: (await $`gh auth token -u avidianity`.quiet().text()).trim() };

async function gh<T>(args: string[]): Promise<T> {
  return JSON.parse(await $`gh ${args}`.env(ghEnv).quiet().text()) as T;
}

interface Run {
  databaseId: number;
  headSha: string;
  conclusion: string;
  status: string;
  url: string;
}

async function findRun(sha: string): Promise<Run> {
  if (values.run) {
    const run = await gh<Run>([
      "run",
      "view",
      values.run,
      "-R",
      REPO,
      "--json",
      "databaseId,headSha,conclusion,status,url",
    ]);
    if (run.headSha !== sha) fail(`run ${run.databaseId} built ${run.headSha}, but the tag points at ${sha}`);
    return run;
  }
  const runs = await gh<Run[]>([
    ...["run", "list", "-R", REPO, "--workflow", WORKFLOW, "--commit", sha],
    ...["--json", "databaseId,headSha,conclusion,status,url", "--limit", "20"],
  ]);
  const run = runs.find((r) => r.status === "completed" && r.conclusion === "success");
  if (!run) {
    fail(
      `no successful ${WORKFLOW} run for ${sha}. Start one with:\n` +
        `  gh workflow run ${WORKFLOW} -R ${REPO} -f tag=v<version> -f publish=false`,
    );
  }
  return run;
}

async function checkBuildJobs(run: Run): Promise<void> {
  const { jobs } = await gh<{ jobs: { name: string; conclusion: string }[] }>([
    ...["run", "view", String(run.databaseId), "-R", REPO, "--json", "jobs"],
  ]);
  for (const platform of Object.keys(TARGETS)) {
    const job = jobs.find((j) => j.name === `build (${platform})`);
    if (job?.conclusion !== "success") fail(`the build (${platform}) job of ${run.url} did not succeed`);
  }
}

// --- tarball checks ------------------------------------------------------------------------

async function tarEntries(tarball: string): Promise<string[]> {
  const listing = await $`tar -tzf ${tarball}`.quiet().text();
  return listing
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^package\//, ""))
    .sort();
}

async function extract(tarball: string, entry: string, into: string): Promise<string> {
  await $`tar -xzf ${tarball} -C ${into} package/${entry}`.quiet();
  return join(into, "package", entry);
}

/** The CPU architecture in a shared library's header: ELF x86-64 or Mach-O arm64. */
function architecture(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) === 0x7f454c46) {
    if (bytes[4] !== 2) return "ELF32";
    return view.getUint16(18, true) === 62 ? "x64" : `ELF machine ${view.getUint16(18, true)}`;
  }
  if (view.getUint32(0, true) === 0xfeedfacf) {
    return view.getUint32(4, true) === 0x0100000c ? "arm64" : `Mach-O cputype ${view.getUint32(4, true)}`;
  }
  return "unknown";
}

/** The newest GLIBC_2.<n> symbol version an ELF file refers to. */
function newestGlibcMinor(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  return Math.max(0, ...[...text.matchAll(/GLIBC_2\.(\d+)/g)].map((m) => Number(m[1])));
}

async function checkTarball(pkg: Pkg, version: string, scratch: string): Promise<void> {
  const entries = await tarEntries(pkg.tarball);
  const manifest = JSON.parse(await Bun.file(await extract(pkg.tarball, "package.json", scratch)).text()) as Manifest;
  if (manifest.name !== pkg.name || manifest.version !== version) {
    fail(`${pkg.tarball} holds ${manifest.name}@${manifest.version}, expected ${pkg.name}@${version}`);
  }
  if (manifest.repository?.url !== REPOSITORY_URL) {
    fail(`${pkg.name} repository.url is ${manifest.repository?.url}; trusted publishing needs ${REPOSITORY_URL}`);
  }

  if (pkg.platform) {
    const target = TARGETS[pkg.platform];
    if (!target) fail(`unknown platform ${pkg.platform}`);
    const shim = `${SHIM}${target.lib.slice(target.lib.lastIndexOf("."))}`;
    const expected = ["LICENSE", "index.ts", target.lib, "package.json", shim].sort();
    if (JSON.stringify(entries) !== JSON.stringify(expected)) {
      fail(`${pkg.name} holds [${entries.join(", ")}], expected [${expected.join(", ")}]`);
    }
    const arch = pkg.platform.split("-")[1];
    for (const lib of [target.lib, shim]) {
      const bytes = await Bun.file(await extract(pkg.tarball, lib, scratch)).bytes();
      const found = architecture(bytes);
      if (found !== arch) fail(`${pkg.name}/${lib} is ${found}, expected ${arch}`);
      console.log(`  ${pkg.name}/${lib}: ${found}, ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB`);
      if (lib === shim && pkg.platform.startsWith("linux")) {
        const minor = newestGlibcMinor(bytes);
        if (minor > MAX_GLIBC_MINOR) fail(`${pkg.name}/${shim} needs glibc 2.${minor}, above 2.${MAX_GLIBC_MINOR}`);
        console.log(`  ${pkg.name}/${shim}: needs glibc 2.${minor}`);
      }
    }
    return;
  }

  for (const [dependency, range] of Object.entries(manifest.optionalDependencies ?? {})) {
    if (range !== version) fail(`${pkg.name} depends on ${dependency}@${range}, expected ${version}`);
  }
  const required = [
    "LICENSE",
    "README.md",
    "package.json",
    "src/neo.ts",
    "src/index.ts",
    "src/bindings/index.ts",
    "vendor/node-api/LICENSE",
    "vendor/node-api/node-bindings.d.ts",
    "vendor/node-api/src/index.ts",
  ];
  const missing = required.filter((entry) => !entries.includes(entry));
  if (missing.length > 0) fail(`${pkg.name} is missing ${missing.join(", ")}`);
  const allowed =
    /^(LICENSE|README\.md|package\.json|src\/.+\.ts|vendor\/node-api\/(LICENSE|PROVENANCE\.md|node-bindings\.d\.ts|src\/.+))$/;
  const unexpected = entries.filter((entry) => !allowed.test(entry));
  if (unexpected.length > 0) fail(`${pkg.name} holds unexpected files: ${unexpected.join(", ")}`);
  console.log(`  ${pkg.name}: ${entries.length} files`);
}

// --- npm registry --------------------------------------------------------------------------

async function onRegistry(name: string, version: string): Promise<boolean> {
  const response = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}/${version}`);
  if (response.status === 404) return false;
  if (response.ok) return true;
  fail(`${REGISTRY} answered ${response.status} for ${name}@${version}`);
}

async function waitForRegistry(name: string, version: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await onRegistry(name, version)) return;
    await Bun.sleep(2000);
  }
  fail(`${name}@${version} was published, but npm did not serve it within 60 s; check npmjs.com before re-running`);
}

// --- main ----------------------------------------------------------------------------------

const root = (await Bun.file(join(ROOT, "package.json")).json()) as Manifest;
const version = root.version;
const tag = `v${version}`;

step(`Release run for ${tag}`);
const sha = (await $`git -C ${ROOT} rev-parse ${`${tag}^{commit}`}`.quiet().nothrow().text()).trim();
if (!/^[0-9a-f]{40}$/.test(sha)) fail(`the tag ${tag} does not exist locally; run git fetch --tags`);
const run = await findRun(sha);
await checkBuildJobs(run);
console.log(`  ${run.url} (${sha.slice(0, 7)})`);

const scratch = await mkdtemp(join(tmpdir(), "duckdb-bun-first-publish-"));
const worktree = join(scratch, "worktree");
const tarballs = join(scratch, "tarballs");
const extracted = join(scratch, "extracted");
try {
  step(`Worktree at ${tag}, with the run's platform packages`);
  await $`git -C ${ROOT} worktree add --detach ${worktree} ${sha}`.quiet();
  for (const platform of Object.keys(TARGETS)) {
    const dir = join(worktree, "packages", `duckdb-bun-${platform}`);
    await $`gh run download ${run.databaseId} -R ${REPO} --name duckdb-bun-${platform} --dir ${dir}`.env(ghEnv).quiet();
    console.log(`  ${platform}: ${(await readdir(dir)).sort().join(", ")}`);
  }

  step("Versions and native files");
  await $`bun run check-version --tag ${tag} --publish`.cwd(worktree);

  step("Tarballs");
  await $`mkdir -p ${tarballs} ${extracted}`.quiet();
  const packages: Pkg[] = [];
  for (const platform of Object.keys(TARGETS)) {
    packages.push({
      dir: `packages/duckdb-bun-${platform}`,
      platform,
      name: `@avidian/duckdb-bun-${platform}`,
      tarball: "",
    });
  }
  packages.push({ dir: ".", name: root.name, tarball: "" });
  for (const pkg of packages) {
    const before = new Set(await readdir(tarballs));
    await $`bun pm pack --destination ${tarballs} --quiet`.cwd(join(worktree, pkg.dir)).quiet();
    const created = (await readdir(tarballs)).filter((file) => !before.has(file));
    if (created.length !== 1) fail(`bun pm pack in ${pkg.dir} wrote ${created.length} tarballs`);
    pkg.tarball = join(tarballs, created[0] as string);
    await checkTarball(pkg, version, extracted);
  }

  step("npm account and plan");
  const whoami = await $`bun pm whoami`.quiet().nothrow();
  if (whoami.exitCode !== 0) {
    fail('bun pm whoami failed: log in to npm first (MAINTENANCE.md, "Publishing to npm")');
  }
  console.log(`  account: ${whoami.text().trim()}`);
  const pending: Pkg[] = [];
  for (const pkg of packages) {
    const published = await onRegistry(pkg.name, version);
    console.log(
      `  ${pkg.name}@${version}: ${published ? "already on npm, skipped" : `publish with --tag ${DIST_TAG}`}`,
    );
    if (!published) pending.push(pkg);
  }
  if (pending.length > 0 && !dryRun) {
    const answer = prompt(`\nPublish ${pending.length} package(s) to npm? Type "publish" to continue:`);
    if (answer?.trim() !== "publish") fail("stopped; nothing was published");
  }

  step(dryRun ? "Publish (dry run)" : "Publish");
  for (const pkg of pending) {
    const args = [pkg.tarball, "--access", "public", "--tag", DIST_TAG, ...(dryRun ? ["--dry-run"] : [])];
    // Inherited stdio: npm's two-factor prompt or browser link goes straight to the terminal.
    const publish = Bun.spawn(["bun", "publish", ...args], { stdio: ["inherit", "inherit", "inherit"] });
    if ((await publish.exited) !== 0)
      fail(`bun publish ${pkg.name} failed; fix it and re-run, published versions are skipped`);
    if (!dryRun) await waitForRegistry(pkg.name, version);
  }

  step("Next: trusted publishers");
  console.log(
    [
      "On npmjs.com, open each package's Settings, Trusted Publisher, GitHub Actions, and enter:",
      ...packages.map((pkg) => `  https://www.npmjs.com/package/${pkg.name}/access`),
      `  Organization or user: ${REPO.split("/")[0]}`,
      `  Repository: ${REPO.split("/")[1]}`,
      `  Workflow filename: ${WORKFLOW}`,
      `  Environment name: ${ENVIRONMENT}`,
      "Each configuration must complete a publish within 2 days, or it expires: release the next version",
      '(MAINTENANCE.md, "Releasing") within 2 days of saving them.',
    ].join("\n"),
  );
} finally {
  await $`git -C ${ROOT} worktree remove --force ${worktree}`.quiet().nothrow();
  await rm(scratch, { recursive: true, force: true });
}
