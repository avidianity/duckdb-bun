//! Blocking DuckDB calls on native threads.
//!
//! Each job export copies its inputs, runs the C call on a pool thread
//! (`pool.rs`) named `duckdb-bun:<op>` in crash reports while the call runs,
//! stores the outcome in the job and calls `on_complete(job)`. Error handling mirrors the official
//! binding's workers (`bindings/src/promise_workers.h`): DuckDB's error text
//! when it gives one, the official fallback message otherwise, and any partial
//! handle destroyed before JavaScript can see it.

use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::mem::size_of;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};

use libduckdb_sys as ffi;

use crate::counters;
use crate::diag;
use crate::handles;
use crate::pool;
use crate::runtime;

/// The duckdb_api value set when no config is passed, as the official binding does.
const DEFAULT_DUCKDB_API: &CStr = c"node-neo-bindings";

/// Ring state: job started.
pub const STATE_START: u32 = 1;
/// Ring state: job ended without error.
pub const STATE_END_OK: u32 = 2;
/// Ring state: job ended with an error.
pub const STATE_END_ERROR: u32 = 3;

/// A job op: the ring op code and the thread name a crash report shows while it runs.
#[derive(Clone, Copy)]
pub struct Op {
    /// Ring op code, the job's position in the ABI table starting at 1.
    pub code: u32,
    /// `duckdb-bun:<op>`.
    pub thread_name: &'static str,
}

pub const OP_OPEN: Op = Op {
    code: 1,
    thread_name: "duckdb-bun:open",
};
pub const OP_GET_OR_CREATE_FROM_CACHE: Op = Op {
    code: 2,
    thread_name: "duckdb-bun:get_or_create_from_cache",
};
pub const OP_CONNECT: Op = Op {
    code: 3,
    thread_name: "duckdb-bun:connect",
};
pub const OP_QUERY: Op = Op {
    code: 4,
    thread_name: "duckdb-bun:query",
};
pub const OP_PREPARE: Op = Op {
    code: 5,
    thread_name: "duckdb-bun:prepare",
};
pub const OP_EXECUTE_PREPARED: Op = Op {
    code: 6,
    thread_name: "duckdb-bun:execute_prepared",
};
pub const OP_EXECUTE_PREPARED_STREAMING: Op = Op {
    code: 7,
    thread_name: "duckdb-bun:execute_prepared_streaming",
};
pub const OP_EXTRACT_STATEMENTS: Op = Op {
    code: 8,
    thread_name: "duckdb-bun:extract_statements",
};
pub const OP_PREPARE_EXTRACTED_STATEMENT: Op = Op {
    code: 9,
    thread_name: "duckdb-bun:prepare_extracted_statement",
};
pub const OP_EXECUTE_PENDING: Op = Op {
    code: 10,
    thread_name: "duckdb-bun:execute_pending",
};
pub const OP_FETCH_CHUNK: Op = Op {
    code: 11,
    thread_name: "duckdb-bun:fetch_chunk",
};

/// The outcome of one job, read by JavaScript through the accessors.
#[derive(Default)]
pub struct Job {
    error: Option<CString>,
    out0: u64,
    out1: u64,
    /// The context the job completes to, set before it is posted.
    context: u64,
    /// The job's op code, which names the kind of handle in `out0`.
    op: u32,
    /// JavaScript read `out0` and owns it from then on.
    taken: AtomicBool,
}

/// Records where a finished job goes and what its output is.
///
/// # Safety
///
/// `job` is live and the calling thread has exclusive access to it.
pub(crate) unsafe fn set_origin(job: *mut Job, context: u64, op: u32) {
    // SAFETY: the caller guarantees exclusive access.
    unsafe {
        (*job).context = context;
        (*job).op = op;
    }
}

/// Frees a job JavaScript will never free, and its output unless JavaScript
/// took it or `owned` (the context's handles, freed by the caller) holds it.
///
/// # Safety
///
/// `job` is a live job from `spawn` that no other thread uses or frees.
pub(crate) unsafe fn discard(job: *mut Job, owned: &HashMap<usize, u32>) {
    // SAFETY: the caller hands over the job.
    let job = unsafe { Box::from_raw(job) };
    let out0 = usize::try_from(job.out0).unwrap_or(0);
    if job.error.is_none()
        && out0 != 0
        && !job.taken.load(Ordering::Acquire)
        && !owned.contains_key(&out0)
        && let Some(kind) = handles::job_output_kind(job.op)
    {
        // SAFETY: a successful job's output that JavaScript never took.
        unsafe { handles::destroy(kind, out0) };
    }
}

type Outcome = Result<(u64, u64), CString>;

/// Runs `work` on a pool thread and returns the job, or null when the calling
/// thread has no context or no thread could run it.
fn spawn(op: Op, handle: u64, work: impl FnOnce() -> Outcome + Send + 'static) -> *mut Job {
    let Some(ticket) = runtime::JobTicket::acquire() else {
        return null_mut();
    };
    let job = Box::into_raw(Box::<Job>::default());
    // A raw pointer is not Send; the address crosses to the thread instead.
    let job_addr = job as usize;

    counters::add(counters::JOBS_STARTED, 1);
    let submitted = pool::submit(Box::new(move || {
        diag::set_thread_name(op.thread_name.as_bytes());
        counters::thread_started();
        diag::record(op.code, STATE_START, handle, 0, &[]);
        let outcome = work();
        let job = job_addr as *mut Job;
        let state = match outcome {
            Ok((out0, out1)) => {
                // SAFETY: JavaScript does not touch the job before
                // `on_complete`, so this thread has exclusive access.
                unsafe {
                    (*job).out0 = out0;
                    (*job).out1 = out1;
                }
                STATE_END_OK
            }
            Err(message) => {
                // SAFETY: as above.
                unsafe { (*job).error = Some(message) };
                STATE_END_ERROR
            }
        };
        diag::record(op.code, state, handle, 0, &[]);
        counters::add(counters::JOBS_COMPLETED, 1);
        counters::thread_finished();
        // Posts the job, or frees it and its output when the JS thread is gone.
        ticket.complete(job, op.code);
    }));
    if submitted {
        job
    } else {
        counters::sub(counters::JOBS_STARTED, 1);
        // SAFETY: the task, and its ticket, were dropped unrun, so nothing else holds the job.
        drop(unsafe { Box::from_raw(job) });
        null_mut()
    }
}

/// Copies `len` bytes at `ptr` and appends a NUL, so the copy outlives the call.
///
/// An interior NUL ends the string early, as `std::string::c_str()` does in the
/// official binding.
///
/// # Safety
///
/// `ptr` points to `len` readable bytes, or `len` is 0.
unsafe fn copy_c_string(ptr: *const u8, len: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(len + 1);
    if len > 0 && !ptr.is_null() {
        // SAFETY: the caller guarantees `len` readable bytes at `ptr`.
        bytes.extend_from_slice(unsafe { std::slice::from_raw_parts(ptr, len) });
    }
    bytes.push(0);
    bytes
}

/// Copies a C string DuckDB owns, or returns `fallback` for null.
///
/// # Safety
///
/// `message` is null or a valid NUL-terminated string.
unsafe fn message_or(message: *const c_char, fallback: &CStr) -> CString {
    if message.is_null() {
        fallback.to_owned()
    } else {
        // SAFETY: the caller guarantees a valid C string.
        unsafe { CStr::from_ptr(message) }.to_owned()
    }
}

fn is_success(state: ffi::duckdb_state) -> bool {
    state == ffi::DuckDBSuccess
}

/// A config created with the default duckdb_api, destroyed on drop.
struct DefaultConfig(ffi::duckdb_config);

impl DefaultConfig {
    fn new() -> Result<Self, CString> {
        let mut config: ffi::duckdb_config = null_mut();
        // SAFETY: `config` is a valid out pointer.
        if !is_success(unsafe { ffi::duckdb_create_config(&mut config) }) {
            // SAFETY: destroying a null or partial config is allowed.
            unsafe { ffi::duckdb_destroy_config(&mut config) };
            return Err(c"Failed to create config".to_owned());
        }
        let config = DefaultConfig(config);
        // SAFETY: the config is live and both strings are NUL-terminated.
        let state = unsafe {
            ffi::duckdb_set_config(
                config.0,
                c"duckdb_api".as_ptr(),
                DEFAULT_DUCKDB_API.as_ptr(),
            )
        };
        if !is_success(state) {
            return Err(c"Failed to set duckdb_api".to_owned());
        }
        Ok(config)
    }
}

impl Drop for DefaultConfig {
    fn drop(&mut self) {
        // SAFETY: the config is live and owned by this value.
        unsafe { ffi::duckdb_destroy_config(&mut self.0) };
    }
}

/// Shared body of `open` and `get_or_create_from_cache`. `open` receives the
/// path (or null), the database out pointer, the config and the error out pointer.
fn open_database(
    path: Option<Vec<u8>>,
    config: usize,
    fallback: &CStr,
    open: impl FnOnce(
        *const c_char,
        *mut ffi::duckdb_database,
        ffi::duckdb_config,
        *mut *mut c_char,
    ) -> ffi::duckdb_state,
) -> Outcome {
    let path_ptr = path.as_ref().map_or(null(), |path| path.as_ptr().cast());
    let default_config = if config == 0 {
        Some(DefaultConfig::new()?)
    } else {
        None
    };
    let config = default_config
        .as_ref()
        .map_or(config as ffi::duckdb_config, |default| default.0);
    let mut database: ffi::duckdb_database = null_mut();
    let mut error: *mut c_char = null_mut();
    // `path_ptr` is null or NUL-terminated, `config` is live (owned by
    // JavaScript until this job completes, or by `default_config`), and both out
    // pointers are valid; `open` relies on that.
    let state = open(path_ptr, &mut database, config, &mut error);
    if is_success(state) {
        return Ok((database as u64, 0));
    }
    // SAFETY: `error` is null or a string DuckDB allocated for us to free.
    let message = unsafe { message_or(error, fallback) };
    if !error.is_null() {
        // SAFETY: allocated by DuckDB, freed once.
        unsafe { ffi::duckdb_free(error.cast()) };
    }
    if !database.is_null() {
        // SAFETY: a partial database handle JavaScript never sees.
        unsafe { ffi::duckdb_close(&mut database) };
    }
    Err(message)
}

/// Runs `execute` into a `duckdb_malloc`ed result, returned as `out0`.
fn run_into_result(
    fallback: &CStr,
    execute: impl FnOnce(*mut ffi::duckdb_result) -> ffi::duckdb_state,
) -> Outcome {
    // SAFETY: plain allocation; checked for null below.
    let result =
        unsafe { ffi::duckdb_malloc(size_of::<ffi::duckdb_result>()) }.cast::<ffi::duckdb_result>();
    if result.is_null() {
        return Err(fallback.to_owned());
    }
    // SAFETY: `result` is a fresh allocation of the right size and alignment.
    unsafe {
        result.write(ffi::duckdb_result {
            deprecated_column_count: 0,
            deprecated_row_count: 0,
            deprecated_rows_changed: 0,
            deprecated_columns: null_mut(),
            deprecated_error_message: null_mut(),
            internal_data: null_mut(),
        })
    };
    if is_success(execute(result)) {
        return Ok((result as u64, 0));
    }
    // SAFETY: `result` is initialized; its error string lives until the destroy,
    // so it is copied first.
    unsafe {
        let message = message_or(ffi::duckdb_result_error(result), fallback);
        ffi::duckdb_destroy_result(result);
        ffi::duckdb_free(result.cast());
        Err(message)
    }
}

/// Shared body of `prepare` and `prepare_extracted_statement`.
fn prepare_with(
    fallback: &CStr,
    prepare: impl FnOnce(*mut ffi::duckdb_prepared_statement) -> ffi::duckdb_state,
) -> Outcome {
    let mut prepared: ffi::duckdb_prepared_statement = null_mut();
    if is_success(prepare(&mut prepared)) {
        return Ok((prepared as u64, 0));
    }
    if prepared.is_null() {
        return Err(fallback.to_owned());
    }
    // SAFETY: `prepared` is a live partial statement; its error string lives
    // until the destroy, so it is copied first.
    unsafe {
        let message = message_or(ffi::duckdb_prepare_error(prepared), fallback);
        ffi::duckdb_destroy_prepare(&mut prepared);
        Err(message)
    }
}

/// Opens a database. `out0`: `duckdb_database`.
///
/// # Safety
///
/// `path` points to `path_len` readable bytes when `has_path`; `config` is null
/// or a live config that stays alive until the job completes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_open(
    path: *const u8,
    path_len: usize,
    has_path: bool,
    config: ffi::duckdb_config,
) -> *mut Job {
    // SAFETY: the caller guarantees the path bytes.
    let path = has_path.then(|| unsafe { copy_c_string(path, path_len) });
    let config = config as usize;
    spawn(OP_OPEN, 0, move || {
        open_database(
            path,
            config,
            c"Failed to open",
            |path, database, config, error| {
                // SAFETY: forwarded from `open_database`.
                unsafe { ffi::duckdb_open_ext(path, database, config, error) }
            },
        )
    })
}

/// Gets or creates a database through an instance cache. `out0`: `duckdb_database`.
///
/// # Safety
///
/// As `dbs_job_open`; `cache` is a live instance cache until the job completes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_get_or_create_from_cache(
    cache: ffi::duckdb_instance_cache,
    path: *const u8,
    path_len: usize,
    has_path: bool,
    config: ffi::duckdb_config,
) -> *mut Job {
    // SAFETY: the caller guarantees the path bytes.
    let path = has_path.then(|| unsafe { copy_c_string(path, path_len) });
    let config = config as usize;
    let cache = cache as usize;
    spawn(OP_GET_OR_CREATE_FROM_CACHE, cache as u64, move || {
        open_database(
            path,
            config,
            c"Failed to get or create from cache",
            move |path, database, config, error| {
                // SAFETY: forwarded from `open_database`; the cache is live.
                unsafe {
                    ffi::duckdb_get_or_create_from_cache(
                        cache as ffi::duckdb_instance_cache,
                        path,
                        database,
                        config,
                        error,
                    )
                }
            },
        )
    })
}

/// Connects to a database. `out0`: `duckdb_connection`.
///
/// # Safety
///
/// `database` is null or live until the job completes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_connect(database: ffi::duckdb_database) -> *mut Job {
    let database = database as usize;
    spawn(OP_CONNECT, database as u64, move || {
        if database == 0 {
            return Err(c"Failed to connect: instance closed".to_owned());
        }
        let mut connection: ffi::duckdb_connection = null_mut();
        // SAFETY: the database is live and the out pointer is valid.
        let state =
            unsafe { ffi::duckdb_connect(database as ffi::duckdb_database, &mut connection) };
        if is_success(state) {
            return Ok((connection as u64, 0));
        }
        if !connection.is_null() {
            // SAFETY: a partial connection JavaScript never sees.
            unsafe { ffi::duckdb_disconnect(&mut connection) };
        }
        Err(c"Failed to connect".to_owned())
    })
}

/// Runs a query. `out0`: `duckdb_result *` from `duckdb_malloc`, owned by
/// JavaScript once read.
///
/// # Safety
///
/// `connection` is null or live until the job completes; `sql` points to
/// `sql_len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_query(
    connection: ffi::duckdb_connection,
    sql: *const u8,
    sql_len: usize,
) -> *mut Job {
    // SAFETY: the caller guarantees the SQL bytes.
    let sql = unsafe { copy_c_string(sql, sql_len) };
    let connection = connection as usize;
    spawn(OP_QUERY, connection as u64, move || {
        if connection == 0 {
            return Err(c"Failed to query: connection disconnected".to_owned());
        }
        run_into_result(c"Failed to query", |result| {
            // SAFETY: live connection, NUL-terminated SQL, initialized result.
            unsafe {
                ffi::duckdb_query(
                    connection as ffi::duckdb_connection,
                    sql.as_ptr().cast(),
                    result,
                )
            }
        })
    })
}

/// Prepares a statement. `out0`: `duckdb_prepared_statement`.
///
/// # Safety
///
/// As `dbs_job_query`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_prepare(
    connection: ffi::duckdb_connection,
    sql: *const u8,
    sql_len: usize,
) -> *mut Job {
    // SAFETY: the caller guarantees the SQL bytes.
    let sql = unsafe { copy_c_string(sql, sql_len) };
    let connection = connection as usize;
    spawn(OP_PREPARE, connection as u64, move || {
        if connection == 0 {
            return Err(c"Failed to prepare: connection disconnected".to_owned());
        }
        prepare_with(c"Failed to prepare", |prepared| {
            // SAFETY: live connection, NUL-terminated SQL, valid out pointer.
            unsafe {
                ffi::duckdb_prepare(
                    connection as ffi::duckdb_connection,
                    sql.as_ptr().cast(),
                    prepared,
                )
            }
        })
    })
}

/// Executes a prepared statement. `out0`: `duckdb_result *`.
///
/// # Safety
///
/// `prepared` is live until the job completes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_execute_prepared(
    prepared: ffi::duckdb_prepared_statement,
) -> *mut Job {
    let prepared = prepared as usize;
    spawn(OP_EXECUTE_PREPARED, prepared as u64, move || {
        run_into_result(c"Failed to execute prepared statement", |result| {
            // SAFETY: live prepared statement, initialized result.
            unsafe {
                ffi::duckdb_execute_prepared(prepared as ffi::duckdb_prepared_statement, result)
            }
        })
    })
}

/// Executes a prepared statement as a streaming result. `out0`: `duckdb_result *`.
///
/// # Safety
///
/// `prepared` is live until the job completes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_execute_prepared_streaming(
    prepared: ffi::duckdb_prepared_statement,
) -> *mut Job {
    let prepared = prepared as usize;
    spawn(OP_EXECUTE_PREPARED_STREAMING, prepared as u64, move || {
        run_into_result(c"Failed to execute prepared statement", |result| {
            // SAFETY: live prepared statement, initialized result.
            unsafe {
                ffi::duckdb_execute_prepared_streaming(
                    prepared as ffi::duckdb_prepared_statement,
                    result,
                )
            }
        })
    })
}

/// Extracts statements. `out0`: `duckdb_extracted_statements`, `out1`: count.
/// A count of 0 means failure; JavaScript reads `duckdb_extract_statements_error`.
///
/// # Safety
///
/// As `dbs_job_query`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_extract_statements(
    connection: ffi::duckdb_connection,
    sql: *const u8,
    sql_len: usize,
) -> *mut Job {
    // SAFETY: the caller guarantees the SQL bytes.
    let sql = unsafe { copy_c_string(sql, sql_len) };
    let connection = connection as usize;
    spawn(OP_EXTRACT_STATEMENTS, connection as u64, move || {
        if connection == 0 {
            return Err(c"Failed to extract statements: connection disconnected".to_owned());
        }
        let mut extracted: ffi::duckdb_extracted_statements = null_mut();
        // SAFETY: live connection, NUL-terminated SQL, valid out pointer.
        let count = unsafe {
            ffi::duckdb_extract_statements(
                connection as ffi::duckdb_connection,
                sql.as_ptr().cast(),
                &mut extracted,
            )
        };
        Ok((extracted as u64, count))
    })
}

/// Prepares one extracted statement. `out0`: `duckdb_prepared_statement`.
///
/// # Safety
///
/// `connection` is null or live, and `extracted` live, until the job completes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_prepare_extracted_statement(
    connection: ffi::duckdb_connection,
    extracted: ffi::duckdb_extracted_statements,
    index: u64,
) -> *mut Job {
    let connection = connection as usize;
    let extracted = extracted as usize;
    spawn(
        OP_PREPARE_EXTRACTED_STATEMENT,
        connection as u64,
        move || {
            if connection == 0 {
                return Err(
                    c"Failed to prepare extracted statement: connection disconnected".to_owned(),
                );
            }
            prepare_with(c"Failed to prepare extracted statement", |prepared| {
                // SAFETY: live connection and extracted statements, valid out pointer.
                unsafe {
                    ffi::duckdb_prepare_extracted_statement(
                        connection as ffi::duckdb_connection,
                        extracted as ffi::duckdb_extracted_statements,
                        index,
                        prepared,
                    )
                }
            })
        },
    )
}

/// Executes a pending result to completion. `out0`: `duckdb_result *`.
///
/// # Safety
///
/// `pending` is live until the job completes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_execute_pending(pending: ffi::duckdb_pending_result) -> *mut Job {
    let pending = pending as usize;
    spawn(OP_EXECUTE_PENDING, pending as u64, move || {
        run_into_result(c"Failed to execute pending result", |result| {
            // SAFETY: live pending result, initialized result.
            unsafe { ffi::duckdb_execute_pending(pending as ffi::duckdb_pending_result, result) }
        })
    })
}

/// Fetches the next chunk of a result. `out0`: `duckdb_data_chunk`, or 0 when
/// the result is exhausted.
///
/// # Safety
///
/// `result` is null or a live result until the job completes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_fetch_chunk(result: *mut ffi::duckdb_result) -> *mut Job {
    let result = result as usize;
    spawn(OP_FETCH_CHUNK, result as u64, move || {
        let result = result as *mut ffi::duckdb_result;
        if result.is_null() {
            return Err(c"Failed to fetch chunk".to_owned());
        }
        // SAFETY: `result` is live; `duckdb_fetch_chunk` takes it by value.
        let mut chunk = unsafe { ffi::duckdb_fetch_chunk(*result) };
        // SAFETY: `result` is live; the error string lives as long as it.
        let error = unsafe { ffi::duckdb_result_error(result) };
        if error.is_null() {
            return Ok((chunk as u64, 0));
        }
        if !chunk.is_null() {
            // SAFETY: a chunk JavaScript never sees.
            unsafe { ffi::duckdb_destroy_data_chunk(&mut chunk) };
        }
        // SAFETY: non-null C string owned by the result.
        Err(unsafe { CStr::from_ptr(error) }.to_owned())
    })
}

/// Whether the job failed.
///
/// # Safety
///
/// `job` is null or a completed job not yet freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_failed(job: *const Job) -> bool {
    // SAFETY: the caller passes a completed, live job.
    unsafe { job.as_ref() }.is_some_and(|job| job.error.is_some())
}

/// The job's error message, or null. Valid until `dbs_job_free`.
///
/// # Safety
///
/// `job` is null or a completed job not yet freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_error(job: *const Job) -> *const c_char {
    // SAFETY: the caller passes a completed, live job.
    unsafe { job.as_ref() }
        .and_then(|job| job.error.as_ref())
        .map_or(null(), |error| error.as_ptr())
}

/// The job's first output.
///
/// # Safety
///
/// `job` is null or a completed job not yet freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_out0(job: *const Job) -> u64 {
    // SAFETY: the caller passes a completed, live job.
    unsafe { job.as_ref() }.map_or(0, |job| {
        job.taken.store(true, Ordering::Release);
        job.out0
    })
}

/// The job's second output.
///
/// # Safety
///
/// `job` is null or a completed job not yet freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_out1(job: *const Job) -> u64 {
    // SAFETY: the caller passes a completed, live job.
    unsafe { job.as_ref() }.map_or(0, |job| job.out1)
}

/// Frees a completed job. Its outputs are not destroyed: JavaScript owns them.
///
/// # Safety
///
/// `job` is null or a completed job not yet freed; it is not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_job_free(job: *mut Job) {
    if !job.is_null() {
        // SAFETY: the caller hands over a live job allocated by `spawn`.
        let job = unsafe { Box::from_raw(job) };
        runtime::job_freed(job.context, std::ptr::from_ref(&*job).cast_mut());
    }
}
