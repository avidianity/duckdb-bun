# duckdb-bun

[![CI](https://github.com/avidianity/duckdb-bun/actions/workflows/ci.yml/badge.svg)](https://github.com/avidianity/duckdb-bun/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![DuckDB v2.0.0](https://img.shields.io/badge/DuckDB-v2.0.0-yellow)
![Bun 1.4.4](https://img.shields.io/badge/Bun-1.4.4-black)

A Bun-native, drop-in reimplementation of [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api) over the libduckdb C API through [`bun:ffi`](https://bun.com/docs/runtime/ffi), with no N-API addon.
It runs the official `@duckdb/node-api` TypeScript layer unmodified over its own bindings, so it has the same API and returns the same value objects.
It loads libduckdb as a plain shared library, so `bun build --compile` produces one self-contained executable, which the official addon cannot do.

```ts
import { DuckDBInstance } from "@avidian/duckdb-bun"; // was "@duckdb/node-api"
```

Version 1.0.0 bundles DuckDB v2.0.0 and matches `@duckdb/node-api` 2.0.0-r.1; [Versions](#versions) maps every release.

## Install

```sh
bun add @avidian/duckdb-bun
```

The package depends on one optional package per platform, which ships libduckdb and the native shim:

| Platform | Package |
| --- | --- |
| Linux x64, glibc 2.36 or newer | `@avidian/duckdb-bun-linux-x64` |
| Linux arm64, glibc 2.36 or newer | `@avidian/duckdb-bun-linux-arm64` |
| macOS arm64 | `@avidian/duckdb-bun-darwin-arm64` |

The linux-arm64 package also serves Docker containers on Apple silicon Macs, which run arm64 Linux images by default.
Bun installs only the one that matches the host.
Do not install with `--no-optional`.
Other platforms are not supported yet, because the native shim is built per platform.

## Versions

The package has its own semantic version, independent of DuckDB's:

- A minor release upgrades DuckDB without breaking the API.
- A patch release fixes the binding between DuckDB releases.
- A major release breaks the API.

Every release is a stable version, so a range such as `^1.0.0` takes every compatible release.

| `@avidian/duckdb-bun` | DuckDB | `@duckdb/node-api` it matches |
| --- | --- | --- |
| 1.0.0 | 2.0.0 | 2.0.0-r.1 |

At run time, `DUCKDB_VERSION` holds the bundled DuckDB version, and `diagnostics().versions` holds all of them:

```ts
import { DUCKDB_VERSION } from "@avidian/duckdb-bun";

console.log(DUCKDB_VERSION); // "2.0.0"
```

## Usage

```ts
import { DuckDBInstance } from "@avidian/duckdb-bun";

const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();
const reader = await connection.runAndReadAll("SELECT 42 AS answer");
console.log(reader.getRowObjects()); // [{ answer: 42 }]
connection.closeSync();
instance.closeSync();
```

Everything in the [`@duckdb/node-api` documentation](https://duckdb.org/docs/stable/clients/node_neo/overview) applies.
The one difference: it runs under Bun, not Node.js.

## Compile to a standalone binary

```sh
bun build --compile app.ts --outfile app
./app
```

The executable embeds libduckdb and the shim.
At start-up it copies both to a temporary directory, because `dlopen` cannot read Bun's embedded file system.

## Diagnostics

`diagnostics()` returns a snapshot of the binding's native state:

```ts
import { diagnostics } from "@avidian/duckdb-bun";

console.log(diagnostics());
```

```js
{
  versions: { package: "1.0.0", duckdb: "v2.0.0", bun: "1.4.4", shim: "0.1.0" },
  paths: { libduckdb: "/…/libduckdb.so", shim: "/…/libduckdb_bun_shim.so" },
  crashHandler: "installed",
  flags: { debug: false, traceSql: false, crashHandler: true },
  tracingChannel: "duckdb-bun:call",
  nativeThreads: { running: 0, peak: 1 },
  jobs: { started: 4, completed: 4, inFlight: 0 },
  callbacks: { posted: 0, completed: 0, inline: 0 },
  ringEntries: 10,
  liveHandles: { database: 1, connection: 1, result: 2 },
}
```

| Field | Meaning |
| --- | --- |
| `versions` | The package, libduckdb, Bun and native shim versions. |
| `paths` | The libduckdb and shim files that were loaded. |
| `crashHandler` | `installed`, `disabled`, or `failed: <reason>`. Queries work without it. |
| `flags` | The [environment flags](#environment-flags) read at load. |
| `nativeThreads` | Native threads running blocking calls now, and the most at once. |
| `jobs` | Blocking calls run on native threads: started, completed, and awaited by JavaScript now. |
| `callbacks` | Scalar and table function callbacks: posted from DuckDB threads, completed, and run inline on the JS thread. |
| `ringEntries` | Events written to the crash report's ring buffer. |
| `liveHandles` | Native handles not yet freed, by kind. A count that only grows points to a leak. |

### Tracing

Every call that runs on a native thread (`open`, `connect`, `query`, `prepare`, `execute_prepared`, `fetch_chunk` and the others) is published on the [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) tracing channel `duckdb-bun:call`.
The context has `op`, the binding function name, and `sql` when `DUCKDB_BUN_TRACE_SQL=1`.

```ts
import { tracingChannel } from "node:diagnostics_channel";

tracingChannel("duckdb-bun:call").subscribe({
  start: (context) => console.time(context.op),
  asyncEnd: (context) => console.timeEnd(context.op),
  error: (context) => console.error(context.op, context.error),
});
```

A call costs nothing extra while no subscriber is attached.

### SQL redaction

SQL text leaves the binding only when `DUCKDB_BUN_TRACE_SQL=1`, and always redacted.
In a statement that can carry credentials, every string literal becomes `'<redacted>'`.
That covers `CREATE SECRET`, `ATTACH`, and any statement that names a secret, password, token, credential, key ID, access key, account key, account name or connection string:

```sql
CREATE SECRET s (TYPE s3, KEY_ID '<redacted>', SECRET '<redacted>')
```

### Crash reports

On a fatal signal (SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT) the binding writes a report to stderr before Bun's own crash report:

```
[duckdb-bun] fatal signal 11 (SIGSEGV) on thread duckdb-bun:query
[duckdb-bun] package 1.0.0, duckdb v2.0.0, bun 1.4.4, shim 0.1.0
[duckdb-bun] in flight: 1 native calls, 1 threads
[duckdb-bun] last binding events, oldest first:
[duckdb-bun]   #5 +0.009s query event conn=0 handle=0x0 thread=0x1b8849f text="SELECT 1"
[duckdb-bun]   #6 +0.009s query start conn=0 handle=0x9bc93a420 thread=0x1b884dc
[duckdb-bun] native backtrace:
…
```

The events come from a ring buffer of the last 256 binding events.
The process still dies of the original signal, with the same exit status.
Include the report when you open an issue.

## Environment flags

| Variable | Effect |
| --- | --- |
| `DUCKDB_BUN_DEBUG=1` | Writes one stderr line per native call, with its outcome and duration, plus the loaded library paths. |
| `DUCKDB_BUN_TRACE_SQL=1` | Adds redacted SQL to the tracing channel context, the debug lines and crash reports. |
| `DUCKDB_BUN_CRASH_HANDLER=0` | Leaves the fatal-signal handler uninstalled. |
| `DUCKDB_BUN_LIBRARY_PATH=/path/libduckdb.so` | Loads this libduckdb instead of the platform package's. It must be the same DuckDB version. |
| `DUCKDB_BUN_OFFLINE=1` | Test suite only: skips the tests that install DuckDB extensions from the network. |

## How it works

- The official `@duckdb/node-api` code is vendored in `vendor/node-api/src` and runs unmodified, except that its `@duckdb/node-bindings` import points at `src/bindings/`.
- `src/bindings/` reimplements the `@duckdb/node-bindings` contract over the libduckdb C API with `bun:ffi`.
  Its FFI tables are generated from DuckDB's C API specification (`bun run gen:ffi`).
- `native/` is a small Rust library, the shim.
  Every C API call from JavaScript goes through a generated C++ wrapper in it that turns a C++ exception from libduckdb into a JavaScript `Error` with DuckDB's message, where it would otherwise abort the process.
  The same wrappers pass the structs that C functions take or return by value, which `bun:ffi` cannot pass.
  It runs every blocking call (open, connect, query, prepare, execute, fetch) on a native thread, so the JS thread never waits for a query.
  It installs the crash handler.
- Every native pointer is owned by a handle object, freed by a `FinalizationRegistry` or by an explicit close, and never while a native call is using it.

The design decisions are recorded in [`docs/adr/`](docs/adr/).

## Performance

Both packages run the same DuckDB, so query time is DuckDB's; the bindings differ only in the calls around it.
On the Linux CI runner, ours reads results and runs prepared statements faster than the official `@duckdb/node-api`, and is on par or lighter elsewhere.
The macOS CI runner is noisy and gives mixed results; see below.

Linux x64 (GitHub runner, 4 vCPU Intel Xeon Platinum 8573C), Bun 1.4.4, DuckDB 2.0.0, median of 10 runs in ABBA order, [CI run 43148152278](https://github.com/avidianity/duckdb-bun/actions/runs/43148152278):

| Scenario | Official | Ours | Ours vs official |
| --- | --- | --- | --- |
| `ingest-json`, 1M rows | 220.4 ms | 216.3 ms | on par |
| `ingest-csv`, 1M rows | 176.6 ms | 170.9 ms | on par; 11% less peak memory (297 vs 334 MiB) |
| `parquet-write`, 1M rows | 157.7 ms | 124.8 ms | on par; 10% less peak memory (302 vs 334 MiB) |
| `read-all`, 1M rows to objects | 1039.2 ms | 882.0 ms | 15% faster; 7% more peak memory (1041 vs 969 MiB) |
| `prepared`, 10,000 bind and run | 580 us per call | 534 us per call | 8% faster |
| `event-loop-lag`, largest timer gap | 10.7 ms | 10.7 ms | on par |

A row claims a difference only where a one-sided Mann-Whitney U test over the 10 runs of each package gives p < 0.01; "on par" means it does not.
The `parquet-write` time looks 21% faster but gives p = 0.044, so it is not claimed.
On the macOS runner (3 vCPU, virtualized) runs of one scenario spread by up to 60%.
In the same CI run there, ours was slower on `ingest-json` (264 vs 205 ms, p = 0.0086) and used more peak memory on `read-all` (821 vs 658 MiB, p = 0.0057), both still inside the gate's 10% limit at 99% confidence.
On an Apple M5 Mac, both scenarios were on par in time, and `read-all` used 17% more peak memory without reaching p < 0.01.
A query that runs out of memory (duckdb-node-neo #3060) rejects with DuckDB's `Out of Memory Error` and leaves the process alive in both packages, on Linux in `oven/bun:1.4.4-slim` and on macOS.
CI fails any change whose bench runs show ours more than 10% slower or 10% heavier than the official package at 99% confidence; [`bench/README.md`](bench/README.md) describes the scenarios and the gate.
Each CI run uploads its full tables as the `bench-<platform>` artifact.

## Known issues

- Terminating a Bun `Worker` with `worker.terminate()` while that Worker runs a query crashes the process with SIGSEGV.
  Bun runs no exit handler in a terminated Worker, so the binding never learns that the Worker's JavaScript is gone, and the finished query calls back into it.
  The official `@duckdb/node-api` crashes on the same sequence under Bun 1.4.4, on the first termination.
  Until a fix ships, let a Worker's queries settle, or close its connections, before terminating it.
- One process can load the package in at most 4094 Workers over its whole life, because each JS thread takes a context id that is never reused (`native/ABI.md`, `dbs_init`).
  A Worker past that limit throws when it loads the package.

## Develop

```sh
bun install
bun run fetch-lib       # libduckdb for the host platform, into packages/duckdb-bun-<platform>/
bun run build:native    # the Rust shim, next to it
bun run test:official   # the vendored @duckdb/node-api suite
bun run test:bindings   # the vendored @duckdb/node-bindings suite
bun run parity          # side-by-side results against the real @duckdb/node-api
bun run fuzz            # generated values and binding calls against the real packages (tests/fuzz/config.ts)
bun run test:unit       # everything else
bun run bench           # benchmarks against the real @duckdb/node-api (bench/README.md)
bun run check           # Biome and the type check
bun run coverage        # line and function coverage of src/ and the shim, with floors (CONTRIBUTING.md)
```

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the rules, and [`MAINTENANCE.md`](MAINTENANCE.md) the upgrade and release procedures.

## Native-JS binding

An older, narrower binding is available at the `/native-js` subpath.
It wraps the main API and returns plain JavaScript values: dates as `YYYY-MM-DD` strings, decimals as numbers, and no wrapper objects.

```ts
import { DuckDBInstance } from "@avidian/duckdb-bun/native-js";
```

| DuckDB type | JS value |
| --- | --- |
| BOOLEAN | `boolean` |
| TINYINT to INTEGER, unsigned up to 32 bits | `number` |
| BIGINT, UBIGINT, HUGEINT, UHUGEINT | `bigint` |
| FLOAT, DOUBLE, DECIMAL | `number` |
| VARCHAR, UUID, ENUM, TIME, TIME_TZ, TIME_NS, BIT | `string` |
| DATE | `string` (`YYYY-MM-DD`) |
| TIMESTAMP, TIMESTAMP_S, _MS, _NS, _TZ | `Date` |
| BLOB | `Uint8Array` |
| INTERVAL | `{ months, days, micros }` |
| LIST, ARRAY | array |
| STRUCT | object |
| MAP | array of `{ key, value }` |
| NULL | `null` |

Values inside LIST, ARRAY, STRUCT and MAP follow the same mapping.

## Alternatives

If you do not need `bun build --compile`, another driver may fit:

| Package | Bun FFI | Embeds libduckdb | Notes |
| --- | --- | --- | --- |
| `@avidian/duckdb-bun` (this) | yes | yes | The `@duckdb/node-api` API on Bun, compile-ready. |
| [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api) | no, N-API | no | The official package and the reference this one is tested against. |
| [`duckdb-bun`](https://github.com/shreeve/duckdb-bun) | yes | no, needs a system libduckdb | Its own driver API. |

## License

MIT.
The vendored `@duckdb/node-api` code is MIT, from DuckDB Labs: see [`vendor/node-api/LICENSE`](vendor/node-api/LICENSE).
