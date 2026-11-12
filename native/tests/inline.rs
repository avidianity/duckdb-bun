//! Function callbacks that DuckDB runs on the JS thread take the sync dispatcher.
//!
//! This binary calls `dbs_init` from the test thread itself, which therefore is
//! the JS thread, and runs queries on it with `threads = 1`.

use std::ffi::{CStr, CString};
use std::ptr::null_mut;

use duckdb_bun_shim::callbacks::{self, Call};
use duckdb_bun_shim::counters;
use duckdb_bun_shim::jobs::Job;
use duckdb_bun_shim::runtime;
use libduckdb_sys as ffi;

extern "C" fn on_complete(_job: *mut Job) {}

extern "C" fn on_call(_call: *mut Call) {
    panic!("no call is posted from the JS thread");
}

extern "C" fn on_release(_id: u64) {}

extern "C" fn on_call_sync(call: *mut Call) {
    // SAFETY: the shim passes a live scalar main call; its chunks and vectors
    // are live for the call.
    unsafe {
        let call = &*call;
        assert_eq!(call.kind, callbacks::KIND_SCALAR_MAIN);
        let input = call.input as ffi::duckdb_data_chunk;
        let rows = ffi::duckdb_data_chunk_get_size(input) as usize;
        let source =
            ffi::duckdb_vector_get_data(ffi::duckdb_data_chunk_get_vector(input, 0)).cast::<i64>();
        let target = ffi::duckdb_vector_get_data(call.output as ffi::duckdb_vector).cast::<i64>();
        for row in 0..rows {
            *target.add(row) = *source.add(row) * 2;
        }
    }
}

/// Runs `sql` on this thread; returns the first cell or DuckDB's error.
fn query(connection: ffi::duckdb_connection, sql: &str) -> Result<i64, String> {
    let sql = CString::new(sql).unwrap();
    // SAFETY: live connection; the result is destroyed before returning.
    unsafe {
        let mut result: ffi::duckdb_result = std::mem::zeroed();
        let outcome =
            if ffi::duckdb_query(connection, sql.as_ptr(), &mut result) == ffi::DuckDBSuccess {
                Ok(ffi::duckdb_value_int64(&mut result, 0, 0))
            } else {
                Err(CStr::from_ptr(ffi::duckdb_result_error(&mut result))
                    .to_string_lossy()
                    .into_owned())
            };
        ffi::duckdb_destroy_result(&mut result);
        outcome
    }
}

#[test]
fn js_thread_calls_run_inline() {
    let context = runtime::dbs_init(Some(on_complete), Some(on_call), Some(on_release));
    assert_eq!(context, 1);
    // A second init from the same thread is refused; the first callbacks stay.
    assert_eq!(
        runtime::dbs_init(Some(on_complete), Some(on_call), Some(on_release)),
        -2
    );

    // SAFETY: handles are created, used on this thread, and destroyed once.
    unsafe {
        let mut database: ffi::duckdb_database = null_mut();
        assert_eq!(
            ffi::duckdb_open(std::ptr::null(), &mut database),
            ffi::DuckDBSuccess
        );
        let mut connection: ffi::duckdb_connection = null_mut();
        assert_eq!(
            ffi::duckdb_connect(database, &mut connection),
            ffi::DuckDBSuccess
        );
        query(connection, "set threads = 1").unwrap();

        let mut function = ffi::duckdb_create_scalar_function();
        ffi::duckdb_scalar_function_set_name(function, c"twice".as_ptr());
        let mut bigint = ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_BIGINT);
        ffi::duckdb_scalar_function_add_parameter(function, bigint);
        ffi::duckdb_scalar_function_set_return_type(function, bigint);
        ffi::duckdb_destroy_logical_type(&mut bigint);
        callbacks::dbs_scalar_function_set_callbacks(
            function,
            ((context as u64) << runtime::CONTEXT_SHIFT) | 7,
            false,
            false,
        );
        assert_eq!(
            ffi::duckdb_register_scalar_function(connection, function),
            ffi::DuckDBSuccess
        );
        ffi::duckdb_destroy_scalar_function(&mut function);

        let sql = "select sum(twice(i))::bigint from range(100000) t(i)";
        let message = query(connection, sql).expect_err("no sync dispatcher yet");
        assert!(message.contains("before dbs_set_sync_call"), "{message}");

        runtime::dbs_set_sync_call(Some(on_call_sync));
        assert_eq!(query(connection, sql), Ok(100000 * 99999));
        assert!(counters::get(counters::CALLS_INLINE) >= 100000 / 2048);
        assert_eq!(counters::get(counters::CALLS_POSTED), 0);

        ffi::duckdb_disconnect(&mut connection);
        ffi::duckdb_close(&mut database);
    }
}
