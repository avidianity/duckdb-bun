//! A context whose JS thread goes away without running more script, as a Worker
//! stopped by `terminate()` does.
//!
//! The test thread is the JS thread. Its `on_complete` and `on_call` record what
//! they receive and never answer, like a thread that runs no more script. After
//! `dbs_context_close_and_free`, the shim must call neither again, release the
//! blocked function callback, interrupt the running query, and free the jobs and
//! handles JavaScript left behind.

use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use duckdb_bun_shim::callbacks::{self, Call};
use duckdb_bun_shim::counters;
use duckdb_bun_shim::handles;
use duckdb_bun_shim::jobs::{self, Job};
use duckdb_bun_shim::runtime;
use libduckdb_sys as ffi;

static COMPLETED: Mutex<Vec<usize>> = Mutex::new(Vec::new());
static CALLS: AtomicUsize = AtomicUsize::new(0);

extern "C" fn on_complete(job: *mut Job) {
    COMPLETED.lock().unwrap().push(job as usize);
}

extern "C" fn on_call(_call: *mut Call) {
    CALLS.fetch_add(1, Ordering::SeqCst);
}

extern "C" fn on_release(_id: u64) {}

fn completed() -> Vec<usize> {
    COMPLETED.lock().unwrap().clone()
}

/// Waits until `done` holds, or fails after a minute.
fn wait_until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(10));
    }
}

/// Waits for `job` to be posted, then reads and frees it as JavaScript does.
fn finish(job: *mut Job) -> u64 {
    assert!(!job.is_null(), "job did not start");
    wait_until("a job", || completed().contains(&(job as usize)));
    // SAFETY: a completed job, freed once.
    unsafe {
        assert!(!jobs::dbs_job_failed(job), "job failed");
        let out = jobs::dbs_job_out0(job);
        jobs::dbs_job_free(job);
        out
    }
}

#[test]
fn closing_frees_what_the_js_thread_left() {
    let context = runtime::dbs_init(Some(on_complete), Some(on_call), Some(on_release));
    assert_eq!(context, 1);

    // SAFETY: handles are created on this thread and handed to the shim, which
    // frees them when the context closes.
    unsafe {
        let database = finish(jobs::dbs_job_open(std::ptr::null(), 0, false, null_mut()));
        handles::dbs_own(handles::KIND_DATABASE, database as *mut c_void);
        let connection = finish(jobs::dbs_job_connect(database as ffi::duckdb_database));
        handles::dbs_own(handles::KIND_CONNECTION, connection as *mut c_void);
        let connection = connection as ffi::duckdb_connection;

        // A handle freed by JavaScript is freed once; a second destroy is ignored.
        let value = ffi::duckdb_create_int64(7);
        handles::dbs_own(handles::KIND_VALUE, value.cast());
        handles::dbs_destroy(handles::KIND_VALUE, value.cast());
        handles::dbs_destroy(handles::KIND_VALUE, value.cast());

        // A scalar function whose posted calls JavaScript never answers.
        let mut function = ffi::duckdb_create_scalar_function();
        ffi::duckdb_scalar_function_set_name(function, c"stuck".as_ptr());
        let mut bigint = ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_BIGINT);
        ffi::duckdb_scalar_function_add_parameter(function, bigint);
        ffi::duckdb_scalar_function_set_return_type(function, bigint);
        ffi::duckdb_destroy_logical_type(&mut bigint);
        callbacks::dbs_scalar_function_set_callbacks(
            function,
            ((context as u64) << runtime::CONTEXT_SHIFT) | 1,
            false,
            false,
        );
        assert_eq!(
            ffi::duckdb_register_scalar_function(connection, function),
            ffi::DuckDBSuccess
        );
        ffi::duckdb_destroy_scalar_function(&mut function);

        // A result JavaScript never read: its completion was posted, not run.
        let sql = "select 42";
        let unread = jobs::dbs_job_query(connection, sql.as_ptr(), sql.len());
        wait_until("the unread result", || {
            completed().contains(&(unread as usize))
        });

        // A query blocked on the JS thread in a function callback.
        let sql = "select sum(stuck(i)) from range(10000000) t(i)";
        let blocked = jobs::dbs_job_query(connection, sql.as_ptr(), sql.len());
        assert!(!blocked.is_null());
        wait_until("a posted call", || CALLS.load(Ordering::SeqCst) > 0);

        runtime::dbs_context_close_and_free();

        // Nothing starts or reaches the closed context any more.
        assert!(jobs::dbs_job_connect(database as ffi::duckdb_database).is_null());
        wait_until("the native threads to stop", || {
            counters::get(counters::THREADS_RUNNING) == 0
        });
        assert!(!completed().contains(&(blocked as usize)));
        assert_eq!(
            counters::get(counters::JOBS_COMPLETED),
            counters::get(counters::JOBS_STARTED)
        );
        assert_eq!(
            counters::get(counters::CALLS_COMPLETED),
            counters::get(counters::CALLS_POSTED)
        );
    }
}
