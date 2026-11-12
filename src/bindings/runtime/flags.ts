// The environment flags the bindings read once at load. README.md documents them.

function enabled(name: string): boolean {
  return process.env[name] === "1";
}

export const flags = {
  /** DUCKDB_BUN_DEBUG=1: one stderr line per native call, plus the loaded library paths. */
  debug: enabled("DUCKDB_BUN_DEBUG"),
  /** DUCKDB_BUN_TRACE_SQL=1: redacted SQL in the tracing channel, debug lines and crash reports. */
  traceSql: enabled("DUCKDB_BUN_TRACE_SQL"),
  /** DUCKDB_BUN_CRASH_HANDLER=0 leaves the fatal-signal handler uninstalled. */
  crashHandler: process.env.DUCKDB_BUN_CRASH_HANDLER !== "0",
} as const;

/** Writes one diagnostic line to stderr when DUCKDB_BUN_DEBUG=1. */
export function debug(line: string): void {
  if (flags.debug) process.stderr.write(`[duckdb-bun] ${line}\n`);
}
