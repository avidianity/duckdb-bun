# 0007 Native memory pressure requests garbage collection

Status: accepted, 2026-11-12.
Extends [0002](0002-handles-are-objects-freed-by-a-finalization-registry.md): handles are still freed by a `FinalizationRegistry`.

## Context

A handle's native memory is freed only after the garbage collector finds the handle unreachable.
The collector sees the JS heap, not the native memory behind a handle, so it does not run sooner when results pile up.
A loop of 10,000 prepared calls of one row each held up to about 1000 unreachable results and their data chunks between collections, against about 500 for the official binding.
The bench measured 38% more peak RSS than the official package on that loop on macOS, and 43% on the macOS CI runner.
With `Bun.gc(false)` called every 200 calls, the same loop grew by 32 MiB instead of 85 MiB, at no measurable cost in time.
N-API offers `napi_adjust_external_memory` for this; `bun:ffi` has no equivalent.

## Decision

Each owned result and data chunk handle adds one to a pressure count, and an explicit destroy of one takes one away.
When the count reaches a limit, the binding calls `Bun.gc(false)`, which asks for a collection without waiting for it (`bun-types` 1.4.4: "force: Synchronously run the garbage collector"), and resets the count.
The limit is 256, or the number of live results and data chunks at that moment when that is larger, so a program that keeps many results alive is not collected more often.

## Rejected options

- Calling `Bun.gc(true)`: it blocks the JS thread for a whole collection.
- Freeing a result's native memory once its last chunk is read: the contract still allows column names, types and other metadata calls on the result afterwards.
- A timer that collects periodically: it runs whether or not native memory piles up, and an idle process would never sleep.

## Consequences

The 10,000-call loop holds at most about 335 unreachable results, and its bench peak RSS went from 38% above the official package to 3% above, with the same time.
A program that creates many results and destroys none starts about one collection per 256 of them.
`tests/runtime/memory-pressure.test.ts` covers the count, the limit and the loop.
