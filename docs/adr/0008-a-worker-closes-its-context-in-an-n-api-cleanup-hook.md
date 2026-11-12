# 0008 A Worker closes its context in an N-API cleanup hook

Status: accepted, 2026-11-12.

## Context

Each JS thread that loads the bindings registers a context with the shim: three thread-safe `JSCallback`s that native threads call to complete a job, run a function callback, or release an id (ADR 0001).
The context was closed only from `process.on("exit")`.
Bun 1.4.4 emits no "exit", "beforeExit" or "close" in a Worker that its parent stops with `terminate()`, and it runs no script in it at all.
The context of a terminated Worker therefore stayed open, and when a query that Worker had started finished, its job thread called a `JSCallback` whose code JSC had freed with the Worker's VM.
Six rounds of terminating a Worker in the middle of a query crashed the process with `SIGSEGV` on thread `duckdb-bun:query`, and each terminated Worker left its native thread, its open database and DuckDB's scheduler threads behind.
The official `@duckdb/node-api` also crashes in this case under Bun 1.4.4.

Bun's own order of a Worker's end, read in its source at the `bun-v1.4.4` tag (commit 38afee6):

1. `WebWorker::shutdown` (`src/jsc/web_worker.rs`) calls `VirtualMachine::exit_and_free` on the Worker's thread.
2. `VirtualMachine::on_exit` (`src/jsc/VirtualMachine.rs`) forbids script for a Worker stopped by its parent, dispatches "exit" handlers (none run then), and calls `run_cleanup_hooks`, because `exit_tears_down_napi_envs` is true for every thread that is not the main thread.
   That runs `NapiEnv::cleanup` (`src/jsc/bindings/napi.h`) for each Node-API environment, which drains the hooks added with `napi_add_env_cleanup_hook`.
3. Only then does `VirtualMachine::teardown` run: the stop phase, the wait for off-thread work, and step C, which destroys the JSC VM and with it every `JSCallback`.
4. The Worker's OS thread returns after that, so a thread-local destructor runs too late.

`process.dlopen` (`src/jsc/bindings/BunProcess.cpp`) calls `dlopen(path, RTLD_LAZY)` and the file's `napi_register_module_v1` with a new environment for the calling global object, so each Worker that loads an addon gets its own environment and its own cleanup hooks.
A thread-safe `JSCallback` posts the call to its script execution context and returns at once (`src/jsc/bindings/JSCFFIBridge.cpp`, `docs/runtime/ffi.mdx`), so posting never waits for the JS thread.

## Decision

The shim is also a Node-API addon: it exports `napi_register_module_v1`, which adds an environment cleanup hook through `napi_add_env_cleanup_hook`, looked up with `dlsym` in the running process so the shim does not link against a Node-API host.
A Worker loads it with `process.dlopen` right after `dbs_init`, and fails to load the bindings if the hook was not added.
The hook runs on the Worker's thread, with the VM alive, on every way a Worker ends: `terminate()`, `process.exit()`, an uncaught error, or its event loop running dry.
The main thread keeps closing its context on "exit".

Closing a context, under the context's lock:

- Marks it closed.
  Every call into the JS thread (a completion, a function callback, a release) is made with that lock held and only while the context is open, so once the close returns none runs or can start.
- Releases each function callback that a DuckDB thread posted and still waits on; that thread reports "the JS thread of this function exited before the callback ran" to DuckDB.
  `dbs_call_done` looks the call up in the context instead of reading it, so a released call is never touched again.
- In a Worker, interrupts every connection JavaScript owns, so a running query ends early.

The shim records every native handle JavaScript owns (`dbs_own`, freed with `dbs_destroy`), every job that is running, and every completion posted to the JS thread and not yet freed by it.
When a Worker's context is closed and no job of it runs, the shim frees all of it: jobs JavaScript never read, with their output, then the handles, those that borrow from a connection before connections and connections before databases.
That happens in the hook, or on the thread of the last job to finish, which counts as a running native thread until it is done.
A job that finishes after its context closed frees its own output.
Nothing in this path reads memory the JS heap owns, and no handle is freed while a job may still use it.

## Rejected options

- Closing from a thread-local destructor on the JS thread: Bun destroys the VM before the thread returns, so a job thread can call a freed callback in between.
- Closing from a `FinalizationRegistry` or a `JSCallback` finalizer: script is forbidden after `terminate()`, and finalizers run while the VM is destroyed, in no order relative to the callbacks.
- Leaving a terminated Worker's handles to process exit: each one keeps a database and DuckDB's scheduler threads alive, so a pool that recycles Workers grows without bound.
- Checking a liveness flag only in the job thread: it closes the window between the check and the call only with a lock that the closing side takes, which is the design above, and it still needs a hook that runs before the VM is destroyed.

## Consequences

Terminating a Worker in the middle of a query, a function callback query or a streaming read no longer crashes, and the Worker's native threads, database and handles are freed; `tests/heavy/worker-terminate.test.ts` checks this over 100 Workers.
Bun lists the shim as a loaded addon, and its crash report counts one `process.dlopen` per Worker.
Each owned handle costs one more FFI call and a hash map entry when it is created.
A query whose job thread starts in the moment the context closes may miss the interrupt, because DuckDB clears it when a query begins; the Worker's handles are then freed once that query ends.
The hook's timing is Bun's behavior, not a documented contract, so a Bun upgrade must re-check the order above (`MAINTENANCE.md`).
