//! Test harness: a fake JS thread, completion and release recorders, and a
//! dispatcher thread that runs posted function callbacks.
//!
//! Each file in `tests/` is its own process, so each gets its own `dbs_init`.

#![allow(dead_code)]

use std::collections::HashSet;
use std::ffi::{CStr, CString};
use std::ptr::null_mut;
use std::sync::mpsc::{self, Sender};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use duckdb_bun_shim::callbacks::Call;
use duckdb_bun_shim::jobs::{self, Job};
use duckdb_bun_shim::runtime;
use libduckdb_sys as ffi;

/// How long a test waits for one job before failing.
pub const JOB_TIMEOUT: Duration = Duration::from_secs(60);

static SERIAL: Mutex<()> = Mutex::new(());

/// Serializes tests in one binary, so the global counters are deterministic.
pub fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Default)]
struct Recorder {
    set: Mutex<HashSet<u64>>,
    cv: Condvar,
}

impl Recorder {
    fn insert(&self, value: u64) {
        self.set
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(value);
        self.cv.notify_all();
    }

    fn wait_for(&self, value: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut set = self.set.lock().unwrap_or_else(PoisonError::into_inner);
        while !set.contains(&value) {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            set = self
                .cv
                .wait_timeout(set, deadline - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        set.remove(&value);
        true
    }
}

static COMPLETED: OnceLock<Recorder> = OnceLock::new();
static RELEASED: OnceLock<Mutex<Vec<u64>>> = OnceLock::new();

fn completed() -> &'static Recorder {
    COMPLETED.get_or_init(Recorder::default)
}

fn released() -> &'static Mutex<Vec<u64>> {
    RELEASED.get_or_init(Mutex::default)
}

/// Handles one posted call on the dispatcher thread. Must not call `dbs_call_done`.
pub type Handler = fn(&Call);

static DISPATCH: OnceLock<Mutex<Sender<usize>>> = OnceLock::new();
static HANDLER: Mutex<Option<Handler>> = Mutex::new(None);

/// Sets the handler the dispatcher thread runs for posted calls.
pub fn set_handler(handler: Handler) {
    *HANDLER.lock().unwrap_or_else(PoisonError::into_inner) = Some(handler);
}

extern "C" fn on_complete(job: *mut Job) {
    completed().insert(job as u64);
}

extern "C" fn on_release(id: u64) {
    released()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(id);
}

extern "C" fn on_call(call: *mut Call) {
    let sender = DISPATCH.get().expect("dispatcher started in init");
    sender
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .send(call as usize)
        .expect("dispatcher thread alive");
}

/// Starts the dispatcher thread and calls `dbs_init` from a separate fake JS
/// thread, so every DuckDB thread the tests use takes the posted path.
pub fn init() {
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<usize>();
        DISPATCH.set(Mutex::new(sender)).expect("first init");
        thread::Builder::new()
            .name("test-dispatcher".into())
            .spawn(move || {
                for call in receiver {
                    let call = call as *mut Call;
                    let handler = *HANDLER.lock().unwrap_or_else(PoisonError::into_inner);
                    // SAFETY: the shim keeps the call alive until `dbs_call_done`.
                    if let Some(handler) = handler {
                        handler(unsafe { &*call });
                    }
                    // SAFETY: posted call, completed exactly once.
                    unsafe { duckdb_bun_shim::callbacks::dbs_call_done(call) };
                }
            })
            .expect("spawn dispatcher");
        let status =
            thread::spawn(|| runtime::dbs_init(Some(on_complete), Some(on_call), Some(on_release)))
                .join()
                .expect("init thread");
        assert_eq!(status, 0);
    });
}

/// Waits for `job` to complete and returns it.
pub fn wait(job: *mut Job) -> *mut Job {
    assert!(!job.is_null(), "job did not start");
    assert!(
        completed().wait_for(job as u64, JOB_TIMEOUT),
        "job did not complete in time"
    );
    job
}

/// The outcome of a completed job, freed.
pub fn finish(job: *mut Job) -> Result<(u64, u64), String> {
    let job = wait(job);
    // SAFETY: `job` completed and is freed exactly once here.
    unsafe {
        let outcome = if jobs::dbs_job_failed(job) {
            Err(CStr::from_ptr(jobs::dbs_job_error(job))
                .to_string_lossy()
                .into_owned())
        } else {
            Ok((jobs::dbs_job_out0(job), jobs::dbs_job_out1(job)))
        };
        jobs::dbs_job_free(job);
        outcome
    }
}

/// Released ids so far.
pub fn released_ids() -> Vec<u64> {
    released()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// An in-memory database and one connection, closed on drop.
pub struct Db {
    pub database: ffi::duckdb_database,
    pub connection: ffi::duckdb_connection,
}

impl Db {
    pub fn open() -> Self {
        // SAFETY: null path and null config ask the shim for an in-memory
        // database with the default config.
        let (database, _) =
            finish(unsafe { jobs::dbs_job_open(std::ptr::null(), 0, false, null_mut()) })
                .expect("open");
        let database = database as ffi::duckdb_database;
        // SAFETY: live database.
        let (connection, _) = finish(unsafe { jobs::dbs_job_connect(database) }).expect("connect");
        Db {
            database,
            connection: connection as ffi::duckdb_connection,
        }
    }

    /// Runs `sql` through the query job and returns the result pointer.
    pub fn query(&self, sql: &str) -> Result<*mut ffi::duckdb_result, String> {
        // SAFETY: live connection, `sql` readable for the call.
        finish(unsafe { jobs::dbs_job_query(self.connection, sql.as_ptr(), sql.len()) })
            .map(|(result, _)| result as *mut ffi::duckdb_result)
    }

    /// Runs `sql` on the calling thread, for setup.
    pub fn exec(&self, sql: &str) {
        let sql = CString::new(sql).expect("no NUL");
        // SAFETY: live connection; the result is destroyed below.
        unsafe {
            let mut result: ffi::duckdb_result = std::mem::zeroed();
            let state = ffi::duckdb_query(self.connection, sql.as_ptr(), &mut result);
            let error = ffi::duckdb_result_error(&mut result);
            let message =
                (!error.is_null()).then(|| CStr::from_ptr(error).to_string_lossy().into_owned());
            ffi::duckdb_destroy_result(&mut result);
            assert_eq!(state, ffi::DuckDBSuccess, "{message:?}");
        }
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        // SAFETY: both handles are live and owned by this value.
        unsafe {
            ffi::duckdb_disconnect(&mut self.connection);
            ffi::duckdb_close(&mut self.database);
        }
    }
}

/// Destroys and frees a result from a job.
pub fn free_result(result: *mut ffi::duckdb_result) {
    // SAFETY: a live `duckdb_malloc`ed result from a job, freed once.
    unsafe {
        ffi::duckdb_destroy_result(result);
        ffi::duckdb_free(result.cast());
    }
}

/// Reads the integer cell at row 0, column 0.
pub fn scalar_i64(result: *mut ffi::duckdb_result) -> i64 {
    // SAFETY: live materialized result.
    unsafe { ffi::duckdb_value_int64(result, 0, 0) }
}
