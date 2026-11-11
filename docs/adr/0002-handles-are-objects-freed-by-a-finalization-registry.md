# 0002 Handles are objects freed by a FinalizationRegistry

Status: accepted, 2026-11-12.

## Context

The imported binding passed raw pointer numbers as handles and never freed a successful result, data chunk, logical type, value, or pending result.
2,000 queries of 20,000 rows grew RSS to 2,120 MB, where `@duckdb/node-api` stayed under 60 MB.
The N-API binding frees each of them in a finalizer on its type-tagged external.

## Decision

Every handle is an object of a class per handle type, holding the native pointer.
A `FinalizationRegistry` frees the native object when the handle is collected, and explicit destroy, close and disconnect functions free it earlier.
A function given a handle of the wrong type throws the official binding's error, such as "Invalid connection argument".
A handle that a native call is using counts the call in `inFlight`; an explicit destroy then only marks it, and the last call to finish frees it, the rule `bindings/src/externals.h` applies to results and pending results.
A handle borrowed from another, such as a vector of a data chunk, holds a reference to its owner and frees nothing.
A native thread never reads memory the JS heap owns: the shim copies strings, and results are allocated with `duckdb_malloc`.

## Consequences

Handles cost one object and one registry entry each.
`diagnostics()` can count handles alive per type, which makes a leak visible.
