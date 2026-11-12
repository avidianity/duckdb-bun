# 0006 Jobs run on a cached thread pool

Status: accepted, 2026-11-12.
Supersedes the "one thread per call" part of [0001](0001-blocking-calls-run-on-native-threads.md); the rest of 0001 stands.

## Context

ADR 0001 started a new `std::thread` with an 8 MiB stack for every blocking call.
The bench against the real `@duckdb/node-api` (CI run 43144924239, Linux x64) measured the `prepared` scenario at 820 us per call for ours and 550 us for the official package, 49% slower, with 24% more peak RSS.
One `runAndReadAll` on a prepared statement is three jobs, so three thread starts per call: thread creation, a stack mapping, an alternate signal stack, and fresh allocator state per thread.
The official binding runs its N-API async work on threads the runtime reuses.

## Decision

The shim keeps one process-wide cached pool (`native/src/pool.rs`) that every JS thread's jobs share.
A job goes to an idle pool thread when one is waiting, and starts a new thread otherwise.
The pool has no size cap, so a long query never makes another call wait for a thread, as with one thread per call.
A thread that stays idle for 10 seconds exits, so a burst of concurrent calls does not hold its threads for the life of the process.
Pool threads have an 8 MiB stack and an alternate signal stack, installed once per thread.
Their OS name is `duckdb-bun:pool`; while a job runs, the crash report names the thread `duckdb-bun:<op>`, as before.
A job that panics does not end its thread.
`diagnostics().nativeThreads` still counts threads running a job, not idle pool threads.

## Rejected options

- A fixed-size pool, as libuv's default of 4: a long query occupies a thread, so enough concurrent long queries would make a short call wait, which the one-thread-per-call design never did.
- Keeping idle threads forever: a burst of concurrent calls would leave its stacks and allocator arenas mapped for the life of the process.
- Running short calls inline on the JS thread: any call can block, such as a prepare that globs a remote folder.

## Consequences

The same `prepared` probe on an Apple M-series Mac went from 195 us per call for ours and 130 us for official to on par, 139 to 166 us for ours against 147 to 195 us for official across runs.
A crash report taken while a pool thread is idle names it `duckdb-bun:pool`.
