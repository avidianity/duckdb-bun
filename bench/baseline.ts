// What the bench compares ours against (bench/README.md, "Baseline"; ADR 0009):
//
// - the @duckdb/node-api reference, when it is built on the pinned DuckDB (tests/reference.ts);
// - otherwise the previous release of this package on npm, installed with `bun add` into a temporary directory,
//   so a DuckDB release that npm has no @duckdb/node-api for yet is still measured against something;
// - otherwise nothing: before the first release there is no previous one, and the gate has no baseline.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HAS_REFERENCE, REFERENCE_VERSION } from "../tests/reference.ts";

export const PACKAGE = "@avidian/duckdb-bun";
const STABLE = /^\d+\.\d+\.\d+$/;

export type Baseline =
  | { kind: "reference"; name: string; version: string }
  | { kind: "release"; name: string; version: string; entry: string };

/** The newest stable version in `published` that is older than `current`, or undefined. */
export function previousRelease(published: readonly string[], current: string): string | undefined {
  return published
    .filter((version) => STABLE.test(version) && Bun.semver.order(version, current) < 0)
    .sort((a, b) => Bun.semver.order(b, a))[0];
}

/** The versions of this package on npm; none when npm does not know the package yet. */
async function publishedVersions(): Promise<string[]> {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE.replace("/", "%2f")}`, {
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`npm answered ${response.status} ${response.statusText} for ${PACKAGE}`);
  return Object.keys(((await response.json()) as { versions?: Record<string, unknown> }).versions ?? {});
}

/**
 * Picks the baseline, and installs it under `dir` when it is a previous release; undefined when there is none.
 * `current` is this package's version.
 */
export async function resolveBaseline(current: string, dir: string): Promise<Baseline | undefined> {
  if (HAS_REFERENCE) return { kind: "reference", name: "@duckdb/node-api", version: REFERENCE_VERSION };
  const version = previousRelease(await publishedVersions(), current);
  if (version === undefined) return undefined;
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "duckdb-bun-bench-baseline", private: true })}\n`,
  );
  // The platform package comes with it as an optional dependency, as for any user.
  const install = Bun.spawnSync([process.execPath, "add", "--exact", `${PACKAGE}@${version}`], {
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (install.exitCode !== 0) throw new Error(`bun add ${PACKAGE}@${version} exited with ${install.exitCode}`);
  return { kind: "release", name: PACKAGE, version, entry: Bun.resolveSync(PACKAGE, dir) };
}

/** The baseline as the report names it. */
export function baselineLabel(baseline: Baseline): string {
  return `${baseline.name} ${baseline.version}`;
}
