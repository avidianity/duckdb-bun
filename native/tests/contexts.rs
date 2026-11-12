//! `dbs_init` and `dbs_context_close` at their limits, and function callbacks that have no
//! JavaScript context to run in. One test, because the context table is global to the process
//! and this file fills it.

use std::ffi::{CStr, CString};
use std::ptr::null_mut;
use std::thread;

use duckdb_bun_shim::callbacks::{self, Call};
use duckdb_bun_shim::jobs::Job;
use duckdb_bun_shim::runtime::{self, CONTEXT_SHIFT, MAX_CONTEXTS};
use libduckdb_sys as ffi;

extern "C" fn on_complete(_job: *mut Job) {}
extern "C" fn on_call(_call: *mut Call) {
    unreachable!("no test here reaches a live context's dispatcher");
}
extern "C" fn on_release(_id: u64) {}

fn init() -> i32 {
    runtime::dbs_init(Some(on_complete), Some(on_call), Some(on_release))
}

/// Registers `SELECT f(1)`'s scalar function `f` with callback id `function_id` on a fresh
/// in-memory database, runs it on this thread, and returns DuckDB's error message.
fn scalar_error(function_id: u64) -> String {
    // SAFETY: every handle is created, used and destroyed here, in order.
    unsafe {
        let mut database: ffi::duckdb_database = null_mut();
        let mut connection: ffi::duckdb_connection = null_mut();
        assert_eq!(
            ffi::duckdb_open(std::ptr::null(), &mut database),
            ffi::DuckDBSuccess
        );
        assert_eq!(
            ffi::duckdb_connect(database, &mut connection),
            ffi::DuckDBSuccess
        );
        let mut function = ffi::duckdb_create_scalar_function();
        ffi::duckdb_scalar_function_set_name(function, c"f".as_ptr());
        let mut bigint = ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_BIGINT);
        ffi::duckdb_scalar_function_add_parameter(function, bigint);
        ffi::duckdb_scalar_function_set_return_type(function, bigint);
        ffi::duckdb_destroy_logical_type(&mut bigint);
        callbacks::dbs_scalar_function_set_callbacks(function, function_id, false, false);
        assert_eq!(
            ffi::duckdb_register_scalar_function(connection, function),
            ffi::DuckDBSuccess
        );
        ffi::duckdb_destroy_scalar_function(&mut function);

        let sql = CString::new("SELECT f(1)").unwrap();
        let mut result: ffi::duckdb_result = std::mem::zeroed();
        let state = ffi::duckdb_query(connection, sql.as_ptr(), &mut result);
        assert_eq!(state, ffi::DuckDBError);
        let message = CStr::from_ptr(ffi::duckdb_result_error(&mut result))
            .to_string_lossy()
            .into_owned();
        ffi::duckdb_destroy_result(&mut result);
        ffi::duckdb_disconnect(&mut connection);
        ffi::duckdb_close(&mut database);
        message
    }
}

#[test]
fn context_limits_and_callbacks_without_a_context() {
    // A null callback is refused.
    assert_eq!(runtime::dbs_init(None, Some(on_call), Some(on_release)), -1);
    assert_eq!(
        runtime::dbs_init(Some(on_complete), None, Some(on_release)),
        -1
    );
    assert_eq!(
        runtime::dbs_init(Some(on_complete), Some(on_call), None),
        -1
    );

    // One open context per thread.
    let first = init();
    assert_eq!(first, 1);
    assert_eq!(init(), -2);

    // A function without a callback id fails its query instead of calling JavaScript.
    let message = scalar_error(0);
    assert!(
        message.contains("duckdb-bun: the function has no callback id"),
        "{message}"
    );

    // A function of a closed context fails its query the same way.
    runtime::dbs_context_close();
    let closed = (first as u64) << CONTEXT_SHIFT | 1;
    let message = scalar_error(closed);
    assert!(message.contains("after its JS thread closed"), "{message}");

    // A closed context's id is never reused: the thread can register again, under a new id.
    assert_eq!(init(), 2);
    runtime::dbs_context_close();

    // dbs_call_done ignores null.
    // SAFETY: null is the documented no-op.
    unsafe { callbacks::dbs_call_done(null_mut()) };

    // Ids run out at MAX_CONTEXTS, closed or not, so every id fits below 2^53.
    let mut last = 2;
    loop {
        let id = thread::spawn(|| {
            let id = init();
            runtime::dbs_context_close();
            id
        })
        .join()
        .expect("thread");
        if id < 0 {
            assert_eq!(id, -3);
            break;
        }
        assert_eq!(id, last + 1);
        last = id;
    }
    assert_eq!(last as usize, MAX_CONTEXTS);
    assert!(((MAX_CONTEXTS as u64 + 1) << CONTEXT_SHIFT) <= 1 << 53);
    assert_eq!(init(), -3);
}
