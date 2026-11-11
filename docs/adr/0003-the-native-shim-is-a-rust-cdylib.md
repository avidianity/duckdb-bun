# 0003 The native shim is a Rust cdylib

Status: accepted, 2026-11-12.

## Context

`bun:ffi` `dlopen` cannot pass or return C structs by value, cannot start threads, and cannot install signal handlers.
The imported binding compiled a C shim at start-up with `bun:ffi` `cc` (TinyCC).
The project rule is that code that is not TypeScript is written in Rust.

## Decision

The shim is the Rust crate in `native/`, built as a cdylib per platform and shipped in each platform package next to libduckdb.
It declares the DuckDB C API through `libduckdb-sys` 1.20000.1 (DuckDB 2.0.0) with default features off, so it links dynamically to the shipped libduckdb with no download and no bundled copy.
It is linked with an rpath of `$ORIGIN` on Linux and `@loader_path` on macOS, so it finds the libduckdb beside it.
The linux-x64 release build runs in the `rust:1.99.1-bookworm` image, so it needs glibc 2.36 or newer.
`native/ABI.md` is the contract between the shim and `src/bindings/`.

## Rejected options

- Keeping the TinyCC shim: compiles C on every start, and the rule forbids new C.
- Hand-written or bindgen declarations: `libduckdb-sys` already ships bindings generated from DuckDB 2.0.0's `duckdb.h`.

## Consequences

Contributors need the Rust toolchain pinned in `rust-toolchain.toml` to run the tests.
There is no runtime compile step, and `bun build --compile` embeds two native files per platform.
