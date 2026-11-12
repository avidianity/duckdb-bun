// The decisions behind a DuckDB upgrade, as pure functions that tests/upgrade-plan.test.ts covers:
// what to upgrade to (scripts/check-version.ts), and the edits scripts/upgrade-duckdb.ts makes.

export type CrateVersion = { num: string; yanked: boolean };

/** The DuckDB version a `<duckdb>-r.<n>` version is built on, or undefined for another shape. */
export function nodeApiBase(version: string): string | undefined {
  return /^(\d+\.\d+\.\d+)-r\.\d+$/.exec(version)?.[1];
}

/** The Versions table and the upgrade use this in place of a `@duckdb/node-api` version when none is built on the DuckDB. */
export const NO_REFERENCE = "none";

/** The newest `@duckdb/node-api` release built on `duckdb`, from npm's list of versions, or undefined. */
export function referenceFor(versions: readonly string[], duckdb: string): string | undefined {
  return versions.filter((version) => nodeApiBase(version) === duckdb).sort((a, b) => Bun.semver.order(b, a))[0];
}

/**
 * What the upstream-check workflow opens an upgrade pull request for (ADR 0009, MAINTENANCE.md "Upgrading DuckDB").
 * A DuckDB release newer than the pin is an upgrade on its own, with the `@duckdb/node-api` built on it as the
 * reference when npm has one: it never waits for one. Otherwise a `@duckdb/node-api` built on the pinned DuckDB that
 * is newer than the reference pin refreshes the reference. Null when nothing is newer.
 */
export function upgradeTarget(
  latestDuckdb: string,
  duckdbPin: string,
  nodeApiVersions: readonly string[],
  nodeApiPin: string,
): { duckdb: string; nodeApi: string | null } | null {
  if (Bun.semver.order(latestDuckdb, duckdbPin) > 0) {
    return { duckdb: latestDuckdb, nodeApi: referenceFor(nodeApiVersions, latestDuckdb) ?? null };
  }
  const reference = referenceFor(nodeApiVersions, duckdbPin);
  if (reference !== undefined && Bun.semver.order(reference, nodeApiPin) > 0) {
    return { duckdb: duckdbPin, nodeApi: reference };
  }
  return null;
}

/**
 * The second component of the libduckdb-sys versions for a DuckDB version. duckdb-rs documents the scheme
 * `1.MAJOR_MINOR_PATCH.x` since DuckDB 1.5.0: DuckDB 1.5.0 is 1.10500.x and DuckDB 2.0.0 is 1.20000.x.
 */
export function crateMinor(duckdb: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(duckdb);
  if (!match) throw new Error(`DuckDB version ${duckdb} is not <major>.<minor>.<patch>`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  if (major < 1 || (major === 1 && minor < 5)) {
    throw new Error(`DuckDB ${duckdb} predates the libduckdb-sys 1.MAJOR_MINOR_PATCH.x scheme`);
  }
  if (minor > 99 || patch > 99) throw new Error(`DuckDB ${duckdb} does not fit the libduckdb-sys version scheme`);
  return major * 10000 + minor * 100 + patch;
}

/** The newest libduckdb-sys release that is not yanked and declares the DuckDB version, or undefined. */
export function matchingCrate(versions: CrateVersion[], duckdb: string): string | undefined {
  const pattern = new RegExp(`^1\\.${crateMinor(duckdb)}\\.\\d+$`);
  return versions
    .filter((version) => !version.yanked && pattern.test(version.num))
    .map((version) => version.num)
    .sort((a, b) => Bun.semver.order(b, a))[0];
}

/** The rows of the `## Versions` table in README.md, as trimmed cells without backticks. */
export function versionRows(readme: string): string[][] {
  const section = readme.split(/^## /m).find((part) => part.startsWith("Versions"));
  if (!section) return [];
  return section
    .split("\n")
    .filter((line) => /^\|\s*\d/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim().replaceAll("`", "")),
    );
}

/**
 * The package version that releases a DuckDB upgrade (ADR 0004): the version the Versions table already gives
 * that DuckDB, so a second run keeps it, or else the next minor version after `current`.
 */
export function upgradeVersion(current: string, rows: string[][], duckdb: string): string {
  const listed = rows.find((row) => row[1] === duckdb)?.[0];
  if (listed) return listed;
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(current);
  if (!match) throw new Error(`package version ${current} is not <major>.<minor>.<patch>`);
  return `${match[1]}.${Number(match[2]) + 1}.0`;
}

/**
 * README.md naming the release in its opening sentence and in a Versions row, added after the last row or replaced.
 * `reference` is the `@duckdb/node-api` release the parity suite and the bench compare against, or undefined when
 * npm has none built on `duckdb`.
 */
export function setReadmeRelease(
  readme: string,
  version: string,
  duckdb: string,
  reference: string | undefined,
): string {
  const sentence = /^Version \d+\.\d+\.\d+ bundles DuckDB v\d+\.\d+\.\d+[^;\n]*;/m;
  if (!sentence.test(readme)) throw new Error("README.md has no sentence that names the bundled versions");
  const lines = readme.replace(sentence, `Version ${version} bundles DuckDB v${duckdb};`).split("\n");
  const heading = lines.indexOf("## Versions");
  if (heading < 0) throw new Error("README.md has no Versions section");
  const end = lines.findIndex((line, index) => index > heading && line.startsWith("## "));
  const rows = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => index > heading && (end < 0 || index < end) && /^\|\s*\d/.test(line));
  const last = rows.at(-1);
  if (!last) throw new Error("README.md has no rows in its Versions table");
  const row = `| ${version} | ${duckdb} | ${reference ?? NO_REFERENCE} |`;
  const same = rows.find(({ line }) => line.split("|")[1]?.trim() === version);
  if (same) lines[same.index] = row;
  else lines.splice(last.index + 1, 0, row);
  return lines.join("\n");
}
