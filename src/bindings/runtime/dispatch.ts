// The JavaScript side of the shim's threading (docs/adr/0001-blocking-calls-run-on-native-threads.md,
// native/ABI.md): completes jobs that ran on native threads, runs function
// callbacks DuckDB makes from its own threads, and releases ids DuckDB no longer
// needs.
//
// The shim calls three thread-safe JSCallbacks from its threads. Bun marshals
// each call onto the JS thread, so everything here runs on the JS thread, and a
// job's completion always runs after the code that started the job has returned.
import { CString, JSCallback, type Pointer, read } from "bun:ffi";
import { isMainThread } from "node:worker_threads";
import type { Handle } from "./handle.ts";
import { shim, shimPath } from "./native.ts";
import { jobOp, record } from "./ring.ts";
import { type CallContext, traced } from "./trace.ts";

// --- keeping the event loop alive -----------------------------------------------

// A JSCallback that a native thread will call later does not keep the process
// alive by itself, so one timer is ref'd while any job is in flight.
const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
keepAlive.unref();
let inFlight = 0;

function begin(): void {
  if (inFlight++ === 0) keepAlive.ref();
}

function end(): void {
  if (--inFlight === 0) keepAlive.unref();
}

// --- jobs -----------------------------------------------------------------------

interface PendingJob {
  handles: readonly Handle[];
  settle(job: Pointer): void;
}

const jobs = new Map<number, PendingJob>();

function complete(job: Pointer): void {
  const entry = jobs.get(job);
  if (!entry) return;
  jobs.delete(job);
  end();
  for (const handle of entry.handles) handle.release();
  try {
    entry.settle(job);
  } finally {
    shim.dbs_job_free(job);
  }
}

/**
 * Runs one blocking C call on a native thread and settles with `read(job)`, or
 * rejects with the job's error text. `context` names the call for tracing. Each handle in `handles` counts the job as
 * in flight until it completes, so an explicit destroy waits for it.
 */
export function runJob<T>(
  context: CallContext,
  handles: readonly Handle[],
  start: () => Pointer | null,
  read: (job: Pointer) => T,
): Promise<T> {
  return traced(context, () => startJob(context, handles, start, read));
}

function startJob<T>(
  context: CallContext,
  handles: readonly Handle[],
  start: () => Pointer | null,
  read: (job: Pointer) => T,
): Promise<T> {
  // The shim records the job's start and end; the SQL, when kept, goes in just before.
  if (context.sql !== undefined) record(jobOp(context.op), null, 0, context.sql);
  for (const handle of handles) handle.acquire();
  const job = start();
  if (job === null) {
    for (const handle of handles) handle.release();
    return Promise.reject(new Error("Failed to start a native thread"));
  }
  begin();
  return new Promise<T>((resolve, reject) => {
    jobs.set(job, {
      handles,
      settle(done) {
        if (shim.dbs_job_failed(done)) {
          const error = shim.dbs_job_error(done);
          reject(new Error(error === null ? "Unknown error" : new CString(error).toString()));
          return;
        }
        try {
          resolve(read(done));
        } catch (error) {
          reject(error);
        }
      },
    });
  });
}

/** Native calls in flight on native threads, for diagnostics(). */
export function jobsInFlight(): number {
  return inFlight;
}

/** The pointer a job produced, or null. */
export function jobOut0(job: Pointer): Pointer | null {
  return shim.dbs_job_out0(job) as Pointer | null;
}

export function jobOut1(job: Pointer): number {
  return Number(shim.dbs_job_out1(job));
}

// --- function callbacks -----------------------------------------------------------

/** Call kinds from native/ABI.md. */
export const CallKind = {
  scalarBind: 1,
  scalarInit: 2,
  scalarMain: 3,
  tableBind: 4,
  tableInit: 5,
  tableLocalInit: 6,
  tableMain: 7,
} as const;

export type CallHandler = (kind: number, info: Pointer, input: Pointer | null, output: Pointer | null) => void;

const handlers = new Map<number, CallHandler>();
const released = new Map<number, () => void>();
let nextId = 1;

/** Ids carry this thread's shim context above bit 40 (2^40), so DuckDB threads call back into the right Worker. */
const CONTEXT_SCALE = 2 ** 40;
let contextBase = 0;

/** Allocates a nonzero id for a function callback set, or for bind, init or state data. */
export function allocateId(): number {
  return contextBase + nextId++;
}

export function setCallHandler(id: number, handler: CallHandler): void {
  handlers.set(id, handler);
}

/** Runs `onRelease` once DuckDB drops `id` (shim `on_release`). */
export function onRelease(id: number, onRelease: () => void): void {
  released.set(id, onRelease);
}

function dispatch(call: Pointer): void {
  const kind = read.u32(call, 0);
  const id = Number(read.u64(call, 8));
  const info = read.ptr(call, 16) as Pointer;
  const input = (read.ptr(call, 24) as Pointer) || null;
  const output = (read.ptr(call, 32) as Pointer) || null;
  const handler = handlers.get(id);
  // The handler reports a thrown error through the C API's set-error function on
  // `info`; an id without a handler is a shim bug, never reached by user code.
  if (handler) handler(kind, info, input, output);
}

const onComplete = new JSCallback((job: Pointer) => complete(job), {
  args: ["ptr"],
  returns: "void",
  threadsafe: true,
});

const onCall = new JSCallback(
  (call: Pointer) => {
    try {
      dispatch(call);
    } finally {
      shim.dbs_call_done(call);
    }
  },
  { args: ["ptr"], returns: "void", threadsafe: true },
);

const onCallSync = new JSCallback((call: Pointer) => dispatch(call), { args: ["ptr"], returns: "void" });

const onReleaseCallback = new JSCallback(
  (id: bigint) => {
    const key = Number(id);
    handlers.delete(key);
    const release = released.get(key);
    released.delete(key);
    release?.();
  },
  { args: ["u64"], returns: "void", threadsafe: true },
);

// One shim context per JS thread: this one, or a Worker's (native/ABI.md, "Lifecycle").
const context = shim.dbs_init(onComplete.ptr, onCall.ptr, onReleaseCallback.ptr);
if (context < 1) throw new Error(`duckdb-bun: the native shim refused this thread (dbs_init returned ${context})`);
contextBase = context * CONTEXT_SCALE;
shim.dbs_set_sync_call(onCallSync.ptr);

if (isMainThread) {
  // After "exit" no more script runs, so the shim drops whatever arrives for this thread.
  process.on("exit", () => shim.dbs_context_close());
} else {
  // A Worker stopped by terminate() emits no "exit" and runs no script, but Bun runs
  // its Node-API cleanup hooks on the Worker's thread before its VM goes away. The
  // shim, loaded as an addon here, adds one that closes this context and frees the
  // handles it owns (docs/adr/0008-a-worker-closes-its-context-in-an-n-api-cleanup-hook.md).
  process.dlopen({ exports: {} }, shimPath);
  if (!shim.dbs_context_hooked()) {
    throw new Error("duckdb-bun: the native shim could not add its Node-API cleanup hook in this Worker");
  }
}
