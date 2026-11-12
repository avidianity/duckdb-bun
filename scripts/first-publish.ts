// Publishes the first version of each package by hand, because npm accepts a trusted publisher
// only for a package that already exists (MAINTENANCE.md, "Publishing to npm"). Every later version
// goes out through the release workflow.
//
//   bun run first-publish [--run <release workflow run id>] [--dry-run] [--yes]
//
// It publishes what a green release workflow run built and tested, never a local build:
//
//  1. Finds the Release run that built the tag `v<version>` with publish off, and checks every build job passed.
//  2. Checks the tag out into a temporary worktree and downloads every platform package into it.
//     Builds the type declarations there (bun run build:types, ADR 0010).
//  3. Runs `check-version --tag --publish`, packs every tarball, and checks each one: its file list,
//     its package.json, the CPU architecture of every native library, and the glibc each Linux library needs.
//  4. Shows the npm account and what it will publish, and asks for confirmation unless --yes.
//  5. Runs `bun publish <tarball> --access public --tag latest`, platform packages first. npm asks for
//     two-factor authentication in the terminal or the browser; the script never sees it.
//  6. Waits up to 20 minutes for npm to serve each version (scripts/npm-registry.ts), then prints the trusted
//     publisher settings to enter on npmjs.com.
//
// A version already on npm is skipped, so a failed run can be re-run. Auth comes from the npm config Bun
// reads (~/.npmrc, or NPM_CONFIG_TOKEN with a short-lived granular token); `bun pm whoami` must succeed.

import { copyFile, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import { TARGETS } from "./fetch-lib.ts";
import { architectures, newestGlibcMinor } from "./native-file.ts";
import { awaitVersion, notServed, onRegistry as servedByNpm } from "./npm-registry.ts";

const REPO = "avidianity/duckdb-bun";
const REPOSITORY_URL = "git+https://github.com/avidianity/duckdb-bun.git";
const WORKFLOW = "release.yml";
const ENVIRONMENT = "npm";
const DIST_TAG = "latest";
const SHIM = "libduckdb_bun_shim";
// The Linux shims are built in rust:1.99.1-bookworm (docs/adr/0003, 0005); the README promises glibc 2.36.
const MAX_GLIBC_MINOR = 36;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    run: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
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
      const path = await extract(pkg.tarball, lib, scratch);
      const bytes = await Bun.file(path).bytes();
      if (bytes.byteLength < 64) fail(`${pkg.name}/${lib} is ${bytes.byteLength} bytes (${path})`);
      const found = architectures(bytes);
      if (!found.includes(arch as string)) fail(`${pkg.name}/${lib} is ${found.join(" + ")}, expected ${arch}`);
      console.log(`  ${pkg.name}/${lib}: ${found.join(" + ")}, ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB`);
      if (pkg.platform.startsWith("linux")) {
        const minor = newestGlibcMinor(bytes);
        if (minor > MAX_GLIBC_MINOR) fail(`${pkg.name}/${lib} needs glibc 2.${minor}, above 2.${MAX_GLIBC_MINOR}`);
        console.log(`  ${pkg.name}/${lib}: needs glibc 2.${minor}`);
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
    "src/api/index.ts",
    "src/bindings/node-bindings.d.ts",
    "src/api/LICENSE",
    "dist/neo.d.ts",
    "dist/index.d.ts",
    "dist/bindings/node-bindings.d.ts",
  ];
  const missing = required.filter((entry) => !entries.includes(entry));
  if (missing.length > 0) fail(`${pkg.name} is missing ${missing.join(", ")}`);
  const allowed = /^(LICENSE|README\.md|package\.json|src\/.+\.ts|dist\/.+\.d\.ts|src\/api\/(LICENSE|PROVENANCE\.md))$/;
  const unexpected = entries.filter((entry) => !allowed.test(entry));
  if (unexpected.length > 0) fail(`${pkg.name} holds unexpected files: ${unexpected.join(", ")}`);
  console.log(`  ${pkg.name}: ${entries.length} files`);
}

// --- npm registry --------------------------------------------------------------------------

async function onRegistry(name: string, version: string): Promise<boolean> {
  try {
    return await servedByNpm(name, version);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function waitForRegistry(name: string, version: string): Promise<void> {
  console.log(`  waiting for npm to serve ${name}@${version}; processing a large tarball takes minutes`);
  if (!(await awaitVersion(name, version))) fail(notServed(name, version));
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
    // gh will not overwrite files, so the artifact lands beside the worktree. Files the tag also holds
    // (package.json, index.ts, LICENSE) must match it byte for byte; the native libraries are copied in.
    const artifact = join(scratch, `artifact-${platform}`);
    const dir = join(worktree, "packages", `duckdb-bun-${platform}`);
    await $`gh run download ${run.databaseId} -R ${REPO} --name duckdb-bun-${platform} --dir ${artifact}`
      .env(ghEnv)
      .quiet();
    const files = (await readdir(artifact)).sort();
    for (const file of files) {
      const source = join(artifact, file);
      const target = join(dir, file);
      if (await Bun.file(target).exists()) {
        if (!Buffer.from(await Bun.file(source).bytes()).equals(Buffer.from(await Bun.file(target).bytes()))) {
          fail(`${file} of the ${platform} artifact differs from the tag's`);
        }
      } else {
        // copyFile, not Bun.write: on Bun 1.4.4, Bun.write to a BunFile whose exists() was awaited writes 0 bytes.
        await copyFile(source, target);
      }
    }
    console.log(`  ${platform}: ${files.join(", ")}`);
  }

  step("Type declarations");
  // The worktree has no node_modules; the repository's own give the build TypeScript and Bun's types.
  await symlink(join(ROOT, "node_modules"), join(worktree, "node_modules"));
  await $`bun run build:types`.cwd(worktree);

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
  if (whoami.exitCode !== 0 && !dryRun) {
    fail('bun pm whoami failed: log in to npm first (MAINTENANCE.md, "Publishing to npm")');
  }
  console.log(`  account: ${whoami.exitCode === 0 ? whoami.text().trim() : "not logged in (dry run continues)"}`);
  const pending: Pkg[] = [];
  for (const pkg of packages) {
    const published = await onRegistry(pkg.name, version);
    console.log(
      `  ${pkg.name}@${version}: ${published ? "already on npm, skipped" : `publish with --tag ${DIST_TAG}`}`,
    );
    if (!published) pending.push(pkg);
  }
  if (pending.length > 0 && !dryRun && !values.yes) {
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
      "Each configuration must complete a publish within 2 days, or it expires: release the next patch",
      'version (MAINTENANCE.md, "Releasing") within 2 days of saving them.',
    ].join("\n"),
  );
} finally {
  await $`git -C ${ROOT} worktree remove --force ${worktree}`.quiet().nothrow();
  await rm(scratch, { recursive: true, force: true });
}
