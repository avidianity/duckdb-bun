// Waits until npm serves a version after a publish, for scripts/first-publish.ts and the release workflow.
//
//   bun scripts/npm-registry.ts wait <name> <version>
//
// npm accepts a publish before it serves the version ("Your package is being processed and may take a few
// minutes to become available"). For 1.0.0, npm served @avidian/duckdb-bun-linux-x64, a 26 MB tarball, 7 min
// 15 s after accepting it, so a publish counts only once npm serves the version, and the wait is long.

export const REGISTRY = "https://registry.npmjs.org";

/** How long to wait for npm to serve a published version: well past the 7 min 15 s seen for 1.0.0. */
export const WAIT_MINUTES = 20;

export type Fetch = (url: string) => Promise<Response>;

/** Whether npm serves `name@version`. */
export async function onRegistry(name: string, version: string, fetchUrl: Fetch = fetch): Promise<boolean> {
  const response = await fetchUrl(`${REGISTRY}/${name.replace("/", "%2f")}/${version}`);
  if (response.status === 404) return false;
  if (response.ok) return true;
  throw new Error(`${REGISTRY} answered ${response.status} for ${name}@${version}`);
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

/** Waits until npm serves `name@version`; false when it does not within the timeout. */
export async function awaitVersion(name: string, version: string, options: WaitOptions = {}): Promise<boolean> {
  const {
    timeoutMs = WAIT_MINUTES * 60_000,
    intervalMs = 10_000,
    fetch: fetchUrl = fetch,
    sleep = Bun.sleep,
    now = Date.now,
  } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await onRegistry(name, version, fetchUrl)) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/** What to do when npm does not serve `name@version` within the wait. */
export function notServed(name: string, version: string, minutes = WAIT_MINUTES): string {
  return [
    `npm accepted ${name}@${version} but did not serve it within ${minutes} minutes.`,
    `Check https://www.npmjs.com/package/${name}, including its Staged Packages tab, before re-running;`,
    'versions already on npm are skipped (MAINTENANCE.md, "Publishing to npm").',
  ].join("\n");
}

if (import.meta.main) {
  const [command, name, version] = Bun.argv.slice(2);
  if (command !== "wait" || name === undefined || version === undefined) {
    console.error("usage: bun scripts/npm-registry.ts wait <name> <version>");
    process.exit(2);
  }
  if (!(await awaitVersion(name, version))) {
    console.error(notServed(name, version));
    process.exit(1);
  }
  console.log(`npm serves ${name}@${version}.`);
}
