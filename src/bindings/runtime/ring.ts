// Records binding events into the shim's crash-forensics ring (native/ABI.md,
// "Diagnostics"). Jobs record their own start and end in the shim; JavaScript
// records the events that happen on the JS thread.
import type { Pointer } from "bun:ffi";
import { shim } from "./native.ts";

/** Op codes from native/ABI.md. */
export const RingOp = {
  close: 32,
  disconnect: 33,
  destroyResult: 34,
  destroyPending: 35,
  destroyPrepared: 36,
  interrupt: 37,
  registerScalarFunction: 38,
  registerTableFunction: 39,
  appenderFlush: 40,
  appenderClose: 41,
  pendingExecuteTask: 42,
} as const;

/** The shim's jobs, in native/ABI.md table order; a job's op code is its position plus one. */
const JOB_OPS = [
  "open",
  "get_or_create_from_cache",
  "connect",
  "query",
  "prepare",
  "execute_prepared",
  "execute_prepared_streaming",
  "extract_statements",
  "prepare_extracted_statement",
  "execute_pending",
  "fetch_chunk",
] as const;

/** The ring op code of a job, by its contract function name; 0 for none. */
export function jobOp(name: string): number {
  return JOB_OPS.indexOf(name as (typeof JOB_OPS)[number]) + 1;
}

const STATE_EVENT = 4;
const TEXT_MAX = 120;
const encoder = new TextEncoder();
const empty = new Uint8Array(1);

/**
 * Appends one event. `text` must already be redacted (see diagnostics.ts); it is
 * truncated to the ring's 120 bytes.
 */
export function record(op: number, handle: Pointer | null, connectionId = 0, text?: string): void {
  const bytes = text ? encoder.encode(text).subarray(0, TEXT_MAX) : empty;
  shim.dbs_ring_record(op, STATE_EVENT, handle ?? 0, connectionId, bytes, text ? bytes.length : 0);
}
