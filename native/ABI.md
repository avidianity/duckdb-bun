# Native shim ABI

The shim is the Rust cdylib `duckdb_bun_shim` in `native/`.
JavaScript loads it with `bun:ffi` `dlopen`, next to libduckdb, and calls only the functions listed here.
This file is the contract between `native/` and `src/bindings/`; change both sides and this file together.

## Conventions

- Every export is `#[no_mangle] pub extern "C"` and named `dbs_<name>`.
- Handles (`duckdb_database`, `duckdb_connection`, `duckdb_result *`, `duckdb_data_chunk`, ...) cross as pointer-sized integers (`FFIType.ptr`).
- A C API function that passes a struct by value gets a wrapper `dbs_<function name without the duckdb_ prefix>`.
  Each by-value struct argument is passed as a pointer to that struct (`*const T`), and a by-value struct return is written through a trailing out pointer (`*mut T`).
  JavaScript builds and reads those buffers in the C layout of `T` from `vendor/duckdb.h`.
  Example: `duckdb_date_struct duckdb_from_date(duckdb_date)` becomes `void dbs_from_date(const duckdb_date *date, duckdb_date_struct *out)`.
- A string argument is a pointer and a byte length (`*const u8, usize`); the shim copies it before it returns, so the caller's buffer needs to live only for the call.
- Nothing the shim keeps after a call returns points into memory JavaScript owns.

## Lifecycle and counters

| Export | Signature | Meaning |
| --- | --- | --- |
| `dbs_init` | `(on_complete: extern "C" fn(*mut Job), on_call: extern "C" fn(*mut Call), on_release: extern "C" fn(u64)) -> i32` | Records the calling thread as the JS thread and stores three callbacks: `on_complete` and `on_release` are thread-safe JSCallbacks, `on_call` is the thread-safe dispatcher for function callbacks. Returns 0, 1 when the shim was already initialized (the first callbacks stay), or 2 when a callback is null. Call once. |
| `dbs_set_sync_call` | `(on_call_sync: extern "C" fn(*mut Call))` | The non-thread-safe dispatcher, used when DuckDB calls a function callback on the JS thread itself. Null clears it. |
| `dbs_counters` | `() -> *const u64` | Pointer to the static counter block below, read by JavaScript through a view. |
| `dbs_version` | `() -> *const c_char` | The shim's crate version, static. |

Counter block, `u64` each, updated with atomics (relaxed is enough).
A job thread counts its job as completed and itself as no longer running before it calls `on_complete`, so the counters are settled when JavaScript sees the completion.

| Index | Counter |
| --- | --- |
| 0 | native threads running |
| 1 | native threads peak |
| 2 | jobs started |
| 3 | jobs completed (callback posted) |
| 4 | function callbacks posted to the JS thread |
| 5 | function callbacks completed |
| 6 | function callbacks run inline on the JS thread |
| 7 | ring entries written |

## Jobs: blocking calls on native threads

Each job export copies its inputs, starts one `std::thread` named `duckdb-bun:<op>` with an 8 MiB stack and an alternate signal stack, runs the C call, stores the outcome in the job, and calls `on_complete(job)`.
It returns the job pointer, or null when the thread could not start or `dbs_init` has not been called (JavaScript then rejects with "Failed to start a native thread").
JavaScript reads the outcome with the accessors and then frees the job.

| Export | Inputs | Outputs |
| --- | --- | --- |
| `dbs_job_open` | `path: *const u8, path_len: usize, has_path: bool, config: duckdb_config` (null for none) | `out0` database |
| `dbs_job_get_or_create_from_cache` | `cache, path, path_len, has_path, config` | `out0` database |
| `dbs_job_connect` | `database` | `out0` connection |
| `dbs_job_query` | `connection, sql: *const u8, sql_len: usize` | `out0` `duckdb_result *` (allocated with `duckdb_malloc`, owned by JavaScript once read) |
| `dbs_job_prepare` | `connection, sql, sql_len` | `out0` prepared statement |
| `dbs_job_execute_prepared` | `prepared` | `out0` `duckdb_result *` |
| `dbs_job_execute_prepared_streaming` | `prepared` | `out0` `duckdb_result *` |
| `dbs_job_extract_statements` | `connection, sql, sql_len` | `out0` extracted statements, `out1` statement count (0 means failure) |
| `dbs_job_prepare_extracted_statement` | `connection, extracted, index: u64` | `out0` prepared statement |
| `dbs_job_execute_pending` | `pending` | `out0` `duckdb_result *` |
| `dbs_job_fetch_chunk` | `result: *mut duckdb_result` | `out0` data chunk or 0 |

Error rules match the official C++ binding's workers (`bindings/src/promise_workers.h` at the vendored tag): the job takes DuckDB's error text (`duckdb_open_ext`'s error out string, `duckdb_result_error`, `duckdb_prepare_error`, `duckdb_extract_statements_error` is left to JavaScript), and on failure destroys whatever partial handle the C call returned, so JavaScript never sees it.
The fallback messages are the official ones, such as "Failed to query" and "Failed to prepare".
A null connection or database fails with the official message, such as "Failed to query: connection disconnected" and "Failed to connect: instance closed".
When `config` is null, `open` and `get_or_create_from_cache` create a config with `duckdb_api` set to `node-neo-bindings`, as the official workers do, and destroy it after the call.
Jobs record their start and end in the ring with the job's first input handle as `handle` and 0 as `connection_id`, since the shim does not know JavaScript's connection ids.

| Accessor | Signature |
| --- | --- |
| `dbs_job_failed` | `(job) -> bool` |
| `dbs_job_error` | `(job) -> *const c_char` (valid until `dbs_job_free`) |
| `dbs_job_out0`, `dbs_job_out1` | `(job) -> u64` |
| `dbs_job_free` | `(job)` |

## Function callbacks: scalar and table functions

DuckDB calls function callbacks on its own threads.
The shim registers its own `extern "C"` trampolines with DuckDB and forwards each call to JavaScript as a `Call`:

- On the JS thread (a task run by `duckdb_pending_execute_task`, for example), it calls `on_call_sync(call)` directly and returns when it returns.
- On any other thread, it posts `on_call(call)` and blocks on a condition variable until JavaScript calls `dbs_call_done(call)`.

`Call` layout (`#[repr(C)]`, read by JavaScript):

| Offset | Field |
| --- | --- |
| 0 | `kind: u32`: 1 scalar bind, 2 scalar init, 3 scalar main, 4 table bind, 5 table init, 6 table local init, 7 table main |
| 8 | `function_id: u64`, the id JavaScript passed when it set the callback |
| 16 | `info: ptr` (bind, init or function info) |
| 24 | `input: ptr` (scalar main: input data chunk; table main: output data chunk) |
| 32 | `output: ptr` (scalar main: output vector) |

JavaScript reports a thrown error through the C API's set-error functions on `info` before it completes the call.

| Export | Meaning |
| --- | --- |
| `dbs_scalar_function_set_callbacks(sf, function_id: u64, has_bind: bool, has_init: bool)` | Sets the shim's main trampoline, and its bind and init trampolines when asked, with extra info holding `function_id`. When DuckDB destroys that extra info, the shim posts `on_release(function_id)`. Call it once per function object, after JavaScript knows all its callbacks, because DuckDB has a single extra info slot. |
| `dbs_table_function_set_callbacks(tf, function_id, has_bind, has_init, has_local_init)` | The same for table functions; the main trampoline is always set. |
| `dbs_set_bind_data(info, kind: u32, data_id: u64)`, `dbs_get_bind_data(info, kind) -> u64` | Bind data as an id; the destroy callback posts `on_release(data_id)`. `kind` is the `Call` kind of the callback that received `info`, which picks the C API family and info type: set takes 1 (scalar bind) or 4 (table bind); get takes 2 or 3 (scalar init or main) or 5, 6 or 7 (table init, local init or main). Other kinds are ignored and read as 0. |
| `dbs_set_init_data(info, data_id)`, `dbs_get_init_data(info) -> u64`, `dbs_get_local_init_data(info) -> u64` | Table function init data, the same way. |
| `dbs_scalar_init_set_state(info, state_id)`, `dbs_scalar_get_state(info) -> u64` | Scalar function state, the same way. |
| `dbs_call_done(call)` | Releases a blocked DuckDB thread. |

Ids are allocated by JavaScript and never 0; 0 means none.

`on_release(id)` fires exactly once per id, and it can arrive on any thread, so it is a thread-safe JSCallback.
Scalar function bind data registers `duckdb_scalar_function_set_bind_data_copy`, as the official binding does: the id sits behind a shared reference count, each copy shares it, and the release fires when the last copy is destroyed.
Table function bind data has no copy callback, and table init data, local init data and scalar state are each owned by one box.

If a function callback runs before `dbs_init`, or on the JS thread before `dbs_set_sync_call`, the shim reports an error on `info` through the C API's set-error function instead of calling JavaScript.

## Diagnostics: ring buffer and crash report

| Export | Meaning |
| --- | --- |
| `dbs_ring_record(op: u32, state: u32, handle: u64, connection_id: u64, text: *const u8, text_len: usize)` | Appends one entry. Jobs record their own start and end; JavaScript records close, disconnect, destroy, interrupt, register, appender flush and close, and pending tasks. `text` is optional SQL already redacted by JavaScript, truncated to 120 bytes. |
| `dbs_install_crash_handler(header: *const u8, header_len: usize) -> i32` | Installs handlers for SIGSEGV, SIGBUS, SIGILL, SIGFPE and SIGABRT with `SA_ONSTACK`, after an alternate signal stack is set for the JS thread, and warms up `backtrace` once. `header` is a line JavaScript builds with the versions. |
| `dbs_crash_for_test(kind: u32)` | 1 dereferences null, 2 aborts. Test use only. |

The ring holds the last 256 entries: sequence number, monotonic time in nanoseconds, op, state (1 start, 2 end ok, 3 end error, 4 event), thread id, handle, connection id, and text.
Op codes are the job ops in table order starting at 1, then 32 close, 33 disconnect, 34 destroy result, 35 destroy pending, 36 destroy prepared, 37 interrupt, 38 register scalar function, 39 register table function, 40 appender flush, 41 appender close, 42 pending execute task.

On a fatal signal the handler writes to fd 2, with async-signal-safe calls only:

```
[duckdb-bun] fatal signal 11 (SIGSEGV) on thread duckdb-bun:query
[duckdb-bun] package 2.0.0-r.0, duckdb v2.0.0, bun 1.4.4, shim 0.1.0
[duckdb-bun] in flight: 2 native calls, 2 threads
[duckdb-bun] last binding events, oldest first:
[duckdb-bun]   #812 +0.004s query start conn=3 handle=0x... thread=0x...
...
[duckdb-bun] native backtrace:
<backtrace_symbols_fd output>
```

Then it restores the previous handler and re-raises the signal, so Bun's own crash report and the exit status stay as they are.
