// The decisions behind a DuckDB upgrade, as pure functions that tests/upgrade-plan.test.ts covers:
// which upstream pair to upgrade to (scripts/check-version.ts), and the edits scripts/upgrade-duckdb.ts makes.

export type CrateVersion = { num: string; yanked: boolean };

/** The DuckDB version a `<duckdb>-r.<n>` version is built on, or undefined for another shape. */
export function nodeApiBase(version: string): string | undefined {
  return /^(\d+\.\d+\.\d+)-r\.\d+$/.exec(version)?.[1];
}

/**
 * The pair to open an upgrade pull request for: the latest @duckdb/node-api when it is newer than the pin
 * and built on the latest DuckDB release. Null while a newer DuckDB waits for its @duckdb/node-api.
 */
export function upgradeTarget(
  latestDuckdb: string,
  latestNodeApi: string,
  nodeApiPin: string,
): { duckdb: string; nodeApi: string } | null {
  if (Bun.semver.order(latestNodeApi, nodeApiPin) <= 0) return null;
  if (nodeApiBase(latestNodeApi) !== latestDuckdb) return null;
  return { duckdb: latestDuckdb, nodeApi: latestNodeApi };
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

/** Sets the value cell of the two-column Markdown table row whose label cell is `label`, keeping its width. */
export function setTableRow(markdown: string, label: string, value: string): string {
  const lines = markdown.split("\n");
  const indices = lines.flatMap((line, index) => (line.split("|")[1]?.trim() === label ? [index] : []));
  if (indices.length !== 1) throw new Error(`expected one table row "${label}", found ${indices.length}`);
  const index = indices[0] as number;
  const cells = (lines[index] as string).split("|");
  if (cells.length !== 4 || cells[2] === undefined) throw new Error(`table row "${label}" does not have two cells`);
  cells[2] = ` ${value} `.padEnd(cells[2].length);
  lines[index] = cells.join("|");
  return lines.join("\n");
}

/**
 * Makes the one block of `import "<prefix><name>";` lines in an official suite entrypoint import exactly the
 * `present` test files: it keeps the order of the files still present and appends new ones, sorted.
 */
export function syncTestImports(
  source: string,
  prefix: string,
  present: string[],
): { source: string; added: string[]; removed: string[] } {
  const lines = source.split("\n");
  const first = lines.findIndex((line) => line.startsWith(prefix));
  const last = lines.findLastIndex((line) => line.startsWith(prefix));
  if (first < 0) throw new Error(`no import of ${prefix}`);
  const block = lines.slice(first, last + 1);
  if (!block.every((line) => line.startsWith(prefix) && line.endsWith('.test.ts";'))) {
    throw new Error(`the imports of ${prefix} are not one block of test file imports`);
  }
  const imported = block.map((line) => line.slice(prefix.length, -'";'.length));
  const removed = imported.filter((name) => !present.includes(name));
  const added = present.filter((name) => !imported.includes(name)).sort();
  const names = [...imported.filter((name) => present.includes(name)), ...added];
  lines.splice(first, block.length, ...names.map((name) => `${prefix}${name}";`));
  return { source: lines.join("\n"), added, removed };
}

/** Replaces the duckdb-node-neo tag in an entrypoint's header comment, which may wrap after the repository name. */
export function setNeoTag(source: string, tag: string): string {
  const header = /(duckdb-node-neo\s+(?:\/\/\s+)?)v\d+\.\d+\.\d+-r\.\d+/;
  if (!header.test(source)) throw new Error("the header comment names no duckdb-node-neo tag");
  return source.replace(header, `$1${tag}`);
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

/** README.md naming the release in its opening sentence and in a Versions row, added after the last row or replaced. */
export function setReadmeRelease(readme: string, version: string, duckdb: string, nodeApi: string): string {
  const sentence = /^Version \d+\.\d+\.\d+ bundles DuckDB v\d+\.\d+\.\d+ and matches `@duckdb\/node-api` [^;\s]+;/m;
  if (!sentence.test(readme)) throw new Error("README.md has no sentence that names the bundled versions");
  const lines = readme
    .replace(sentence, `Version ${version} bundles DuckDB v${duckdb} and matches \`@duckdb/node-api\` ${nodeApi};`)
    .split("\n");
  const heading = lines.indexOf("## Versions");
  if (heading < 0) throw new Error("README.md has no Versions section");
  const end = lines.findIndex((line, index) => index > heading && line.startsWith("## "));
  const rows = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => index > heading && (end < 0 || index < end) && /^\|\s*\d/.test(line));
  const last = rows.at(-1);
  if (!last) throw new Error("README.md has no rows in its Versions table");
  const row = `| ${version} | ${duckdb} | ${nodeApi} |`;
  const same = rows.find(({ line }) => line.split("|")[1]?.trim() === version);
  if (same) lines[same.index] = row;
  else lines.splice(last.index + 1, 0, row);
  return lines.join("\n");
}
