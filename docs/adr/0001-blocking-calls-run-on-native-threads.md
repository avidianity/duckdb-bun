# 0001 Blocking calls run on native threads

Status: accepted, 2026-11-12.
The "one thread per call" part is superseded by [0006](0006-jobs-run-on-a-cached-thread-pool.md).

## Context

The imported binding called every DuckDB function synchronously on the JS thread.
A 3.3 s query let a 10 ms timer fire 0 times out of 332, where `@duckdb/node-api` let it fire 321 times out of 352.
A server that runs one query therefore stops serving every other request, and a timer that calls `interrupt()` can never run.

## Decision

Every function of the `@duckdb/node-bindings` contract that returns a Promise runs on a native thread that the Rust shim starts, one thread per call, named `duckdb-bun:<op>`, with an 8 MiB stack.
The thread calls a `threadsafe: true` `JSCallback` when it finishes, and Bun runs that callback on the JS thread, where the Promise settles.
A referenced timer keeps the event loop alive while any call is in flight.
Scalar and table function callbacks that DuckDB calls on its own threads are posted to the JS thread the same way, and the DuckDB thread waits until JavaScript has run them.
That removes the `threads=1` pin the imported binding needed for scalar functions.
Each JS thread that loads the bindings, the main thread and every Worker, registers its own callbacks with the shim as a context.
A call completes to the context that started it, and a function callback goes to the context encoded in its id, as the official binding's per-environment thread-safe functions do.
A Worker closes its context when it ends, including through `terminate()`, and the shim drops anything posted to it afterwards (ADR 0008).

## Rejected options

- Driving the query with `duckdb_pending_execute_task` and yielding between tasks: binding and planning, such as a glob over a remote folder, and any single long task still block the JS thread.
- A pool of Bun Workers: a second JS heap per worker, a concurrency cap, and a message hop for every chunk.
- N-API async work through `bun:ffi` `cc`: on Bun 1.4.4, `cc` passes wrong values for every argument after `napi_env`.

## Consequences

Bun documents thread-safe `JSCallback` as experimental (`bun-types` 1.4.4, `docs/runtime/ffi.mdx`); the README lists that as a known limit.
A prototype completed 20,000 concurrent native jobs correctly, with about 11 us per round trip.
