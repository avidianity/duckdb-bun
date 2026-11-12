// diagnostics(): a snapshot of the binding's native state, for leak hunting,
// support requests and health checks. README.md documents every field.
import { toArrayBuffer } from "bun:ffi";
import { jobsInFlight } from "./dispatch.ts";
import { flags } from "./flags.ts";
import { liveHandles } from "./handle.ts";
import { crashHandler, libraryPath, shim, shimPath, versions } from "./native.ts";
import { CALL_CHANNEL } from "./trace.ts";

export interface Diagnostics {
  versions: { package: string; duckdb: string; bun: string; shim: string };
  paths: { libduckdb: string; shim: string };
  crashHandler: string;
  flags: { debug: boolean; traceSql: boolean; crashHandler: boolean };
  tracingChannel: string;
  /** Native threads running blocking calls now, and the most at once. */
  nativeThreads: { running: number; peak: number };
  /** Blocking calls run on native threads: started, completed, and awaited by JavaScript now. */
  jobs: { started: number; completed: number; inFlight: number };
  /** Scalar and table function callbacks DuckDB made: posted from its threads, completed, and run inline. */
  callbacks: { posted: number; completed: number; inline: number };
  /** Entries written to the crash-report ring buffer. */
  ringEntries: number;
  /** Owned native handles not yet freed, by kind. */
  liveHandles: Record<string, number>;
}

const COUNTERS = 8;

export function diagnostics(): Diagnostics {
  const counters = new BigUint64Array(toArrayBuffer(shim.dbs_counters() as never, 0, COUNTERS * 8));
  const at = (index: number) => Number(counters[index]);
  return {
    versions: { ...versions },
    paths: { libduckdb: libraryPath, shim: shimPath },
    crashHandler,
    flags: { ...flags },
    tracingChannel: CALL_CHANNEL,
    nativeThreads: { running: at(0), peak: at(1) },
    jobs: { started: at(2), completed: at(3), inFlight: jobsInFlight() },
    callbacks: { posted: at(4), completed: at(5), inline: at(6) },
    ringEntries: at(7),
    liveHandles: liveHandles(),
  };
}
