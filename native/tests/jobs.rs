//! Jobs and posted function callbacks against a real in-memory DuckDB.

mod common;

use std::ffi::{CString, c_void};
use std::ptr::null_mut;
use std::sync::atomic::{AtomicI64, Ordering};
use std::thread;
use std::time::Duration;

use common::{Db, finish, free_result, scalar_i64, serial};
use duckdb_bun_shim::callbacks::{self, Call};
use duckdb_bun_shim::counters;
use duckdb_bun_shim::jobs;
use libduckdb_sys as ffi;

#[test]
fn query_round_trip() {
    let _serial = serial();
    common::init();
    let db = Db::open();
    let result = db.query("select 40 + 2").expect("query");
    assert_eq!(scalar_i64(result), 42);
    free_result(result);
}

#[test]
fn bad_sql_rejects_with_duckdb_message() {
    let _serial = serial();
    common::init();
    let db = Db::open();
    let message = db.query("selec 1").expect_err("bad SQL fails");
    assert!(message.contains("Parser Error"), "{message}");
    assert!(message.contains("syntax error"), "{message}");
}

#[test]
fn open_error_is_duckdb_message() {
    let _serial = serial();
    common::init();
    let path = "/nonexistent-duckdb-bun-dir/sub/db.duckdb";
    // SAFETY: `path` is readable for the call; null config takes the default.
    let message =
        finish(unsafe { jobs::dbs_job_open(path.as_ptr(), path.len(), true, null_mut()) })
            .expect_err("open fails");
    assert!(message.contains("nonexistent-duckdb-bun-dir"), "{message}");
}

#[test]
fn default_config_sets_duckdb_api() {
    let _serial = serial();
    common::init();
    let db = Db::open();
    let result = db
        .query("select current_setting('duckdb_api') = 'node-neo-bindings'")
        .expect("query");
    // SAFETY: live materialized result.
    assert!(unsafe { ffi::duckdb_value_boolean(result, 0, 0) });
    free_result(result);
}

#[test]
fn closed_handles_reject_with_official_messages() {
    let _serial = serial();
    common::init();
    // SAFETY: null handles are rejected before any C call.
    unsafe {
        assert_eq!(
            finish(jobs::dbs_job_connect(null_mut())).unwrap_err(),
            "Failed to connect: instance closed"
        );
        assert_eq!(
            finish(jobs::dbs_job_query(null_mut(), "select 1".as_ptr(), 8)).unwrap_err(),
            "Failed to query: connection disconnected"
        );
    }
}

#[test]
fn interrupt_rejects_long_query() {
    let _serial = serial();
    common::init();
    let db = Db::open();
    let sql = "select count(*) from range(1000000000) a, range(1000000000) b";
    // SAFETY: live connection; `sql` readable for the call.
    let job = unsafe { jobs::dbs_job_query(db.connection, sql.as_ptr(), sql.len()) };
    assert!(!job.is_null());
    // DuckDB clears the interrupt flag when a query starts, so keep
    // interrupting until the job completes.
    let connection = db.connection as usize;
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let interrupter = {
        let stop = stop.clone();
        thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(50));
                // SAFETY: the connection stays live until the test ends.
                unsafe { ffi::duckdb_interrupt(connection as ffi::duckdb_connection) };
            }
        })
    };
    let outcome = finish(job);
    stop.store(true, Ordering::Relaxed);
    interrupter.join().expect("interrupter");
    let message = outcome.expect_err("interrupted query fails");
    assert!(message.contains("Interrupted"), "{message}");
}

#[test]
fn fetch_chunk_streams_all_rows() {
    let _serial = serial();
    common::init();
    let db = Db::open();
    let sql = "select i from range(10000) t(i)";
    // SAFETY: live connection; `sql` readable for the call.
    let (prepared, _) =
        finish(unsafe { jobs::dbs_job_prepare(db.connection, sql.as_ptr(), sql.len()) })
            .expect("prepare");
    let mut prepared = prepared as ffi::duckdb_prepared_statement;
    // SAFETY: live prepared statement.
    let (result, _) = finish(unsafe { jobs::dbs_job_execute_prepared_streaming(prepared) })
        .expect("execute streaming");
    let result = result as *mut ffi::duckdb_result;
    // SAFETY: live result.
    assert!(unsafe { ffi::duckdb_result_is_streaming(*result) });
    let mut rows = 0;
    let mut chunks = 0;
    loop {
        // SAFETY: live result.
        let (chunk, _) = finish(unsafe { jobs::dbs_job_fetch_chunk(result) }).expect("fetch");
        if chunk == 0 {
            break;
        }
        let mut chunk = chunk as ffi::duckdb_data_chunk;
        // SAFETY: live chunk, destroyed once.
        unsafe {
            rows += ffi::duckdb_data_chunk_get_size(chunk);
            ffi::duckdb_destroy_data_chunk(&mut chunk);
        }
        chunks += 1;
    }
    assert_eq!(rows, 10000);
    assert!(chunks > 1);
    free_result(result);
    // SAFETY: live prepared statement, destroyed once.
    unsafe { ffi::duckdb_destroy_prepare(&mut prepared) };
}

#[test]
fn prepare_error_and_extracted_statements() {
    let _serial = serial();
    common::init();
    let db = Db::open();
    let bad = "select * from missing_table";
    // SAFETY: live connection; `bad` readable for the call.
    let message = finish(unsafe { jobs::dbs_job_prepare(db.connection, bad.as_ptr(), bad.len()) })
        .expect_err("prepare fails");
    assert!(message.contains("missing_table"), "{message}");

    let sql = "select 1; select 2 + 5";
    // SAFETY: live connection; `sql` readable for the call.
    let (extracted, count) =
        finish(unsafe { jobs::dbs_job_extract_statements(db.connection, sql.as_ptr(), sql.len()) })
            .expect("extract");
    assert_eq!(count, 2);
    let mut extracted = extracted as ffi::duckdb_extracted_statements;
    // SAFETY: live connection and extracted statements.
    let (prepared, _) =
        finish(unsafe { jobs::dbs_job_prepare_extracted_statement(db.connection, extracted, 1) })
            .expect("prepare");
    let mut prepared = prepared as ffi::duckdb_prepared_statement;
    let mut pending: ffi::duckdb_pending_result = null_mut();
    // SAFETY: live prepared statement, valid out pointer.
    assert_eq!(
        unsafe { ffi::duckdb_pending_prepared(prepared, &mut pending) },
        ffi::DuckDBSuccess
    );
    // SAFETY: live pending result.
    let (result, _) =
        finish(unsafe { jobs::dbs_job_execute_pending(pending) }).expect("execute pending");
    let result = result as *mut ffi::duckdb_result;
    assert_eq!(scalar_i64(result), 7);
    free_result(result);
    // SAFETY: each handle is live and destroyed once.
    unsafe {
        ffi::duckdb_destroy_pending(&mut pending);
        ffi::duckdb_destroy_prepare(&mut prepared);
        ffi::duckdb_destroy_extracted(&mut extracted);
    }
}

const PLUS_ONE_ID: u64 = 101;
const PLUS_ONE_BIND_DATA: u64 = 102;
const SEQ_ID: u64 = 201;
const SEQ_BIND_DATA: u64 = 202;
const SEQ_INIT_DATA: u64 = 203;
const SEQ_LOCAL_INIT_DATA: u64 = 204;
const SEQ_ROWS: i64 = 5000;

static SEQ_EMITTED: AtomicI64 = AtomicI64::new(0);

/// Runs posted calls for `plus_one(x)` and `seq_rows()` on the dispatcher thread.
fn handle(call: &Call) {
    // SAFETY: each arm uses the C API for the info and chunks of its kind, all
    // live until `dbs_call_done`.
    unsafe {
        match call.kind {
            callbacks::KIND_SCALAR_BIND => {
                callbacks::dbs_set_bind_data(
                    call.info.cast(),
                    call.kind,
                    common::sibling(call.function_id, PLUS_ONE_BIND_DATA),
                );
            }
            callbacks::KIND_SCALAR_MAIN => {
                let increment = callbacks::dbs_get_bind_data(call.info, call.kind) as i64
                    - common::sibling(call.function_id, PLUS_ONE_BIND_DATA) as i64
                    + 1;
                let input = call.input as ffi::duckdb_data_chunk;
                let rows = ffi::duckdb_data_chunk_get_size(input) as usize;
                let source =
                    ffi::duckdb_vector_get_data(ffi::duckdb_data_chunk_get_vector(input, 0))
                        .cast::<i64>();
                let target =
                    ffi::duckdb_vector_get_data(call.output as ffi::duckdb_vector).cast::<i64>();
                for row in 0..rows {
                    *target.add(row) = *source.add(row) + increment;
                }
            }
            callbacks::KIND_TABLE_BIND => {
                let mut bigint =
                    ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_BIGINT);
                ffi::duckdb_bind_add_result_column(call.info.cast(), c"i".as_ptr(), bigint);
                ffi::duckdb_destroy_logical_type(&mut bigint);
                callbacks::dbs_set_bind_data(
                    call.info.cast(),
                    call.kind,
                    common::sibling(call.function_id, SEQ_BIND_DATA),
                );
            }
            callbacks::KIND_TABLE_INIT => {
                SEQ_EMITTED.store(0, Ordering::Relaxed);
                callbacks::dbs_set_init_data(
                    call.info.cast(),
                    common::sibling(call.function_id, SEQ_INIT_DATA),
                );
            }
            callbacks::KIND_TABLE_LOCAL_INIT => {
                callbacks::dbs_set_init_data(
                    call.info.cast(),
                    common::sibling(call.function_id, SEQ_LOCAL_INIT_DATA),
                );
            }
            callbacks::KIND_TABLE_MAIN => {
                let info = call.info as ffi::duckdb_function_info;
                let ids = (
                    callbacks::dbs_get_bind_data(call.info, call.kind),
                    callbacks::dbs_get_init_data(info),
                    callbacks::dbs_get_local_init_data(info),
                );
                let expected = (
                    common::sibling(call.function_id, SEQ_BIND_DATA),
                    common::sibling(call.function_id, SEQ_INIT_DATA),
                    common::sibling(call.function_id, SEQ_LOCAL_INIT_DATA),
                );
                if ids != expected {
                    let message = CString::new(format!("unexpected ids {ids:?}")).unwrap();
                    ffi::duckdb_function_set_error(info, message.as_ptr());
                    return;
                }
                let output = call.input as ffi::duckdb_data_chunk;
                let start = SEQ_EMITTED.load(Ordering::Relaxed);
                let count = (SEQ_ROWS - start).min(ffi::duckdb_vector_size() as i64);
                let target =
                    ffi::duckdb_vector_get_data(ffi::duckdb_data_chunk_get_vector(output, 0))
                        .cast::<i64>();
                for row in 0..count {
                    *target.add(row as usize) = start + row;
                }
                ffi::duckdb_data_chunk_set_size(output, count as u64);
                SEQ_EMITTED.store(start + count, Ordering::Relaxed);
            }
            _ => {}
        }
    }
}

fn release_count(id: u64) -> usize {
    common::released_ids()
        .iter()
        .filter(|released| **released == id)
        .count()
}

#[test]
fn scalar_function_runs_through_posted_path() {
    let _serial = serial();
    common::init();
    common::set_handler(handle);
    let db = Db::open();
    db.exec("set threads = 4");
    let inline_before = counters::get(counters::CALLS_INLINE);
    let posted_before = counters::get(counters::CALLS_POSTED);
    // SAFETY: the function is configured, registered, then destroyed once.
    unsafe {
        let mut function = ffi::duckdb_create_scalar_function();
        ffi::duckdb_scalar_function_set_name(function, c"plus_one".as_ptr());
        let mut bigint = ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_BIGINT);
        ffi::duckdb_scalar_function_add_parameter(function, bigint);
        ffi::duckdb_scalar_function_set_return_type(function, bigint);
        ffi::duckdb_destroy_logical_type(&mut bigint);
        callbacks::dbs_scalar_function_set_callbacks(
            function,
            common::id(PLUS_ONE_ID),
            true,
            false,
        );
        assert_eq!(
            ffi::duckdb_register_scalar_function(db.connection, function),
            ffi::DuckDBSuccess
        );
        ffi::duckdb_destroy_scalar_function(&mut function);
    }
    let result = db
        .query("select sum(plus_one(i))::bigint from range(1000000) t(i)")
        .expect("query");
    assert_eq!(scalar_i64(result), 1_000_000 * 999_999 / 2 + 1_000_000);
    free_result(result);

    let posted = counters::get(counters::CALLS_POSTED) - posted_before;
    assert!(posted >= 1_000_000 / 2048, "posted {posted}");
    assert_eq!(counters::get(counters::CALLS_INLINE), inline_before);
    assert_eq!(
        counters::get(counters::CALLS_COMPLETED),
        counters::get(counters::CALLS_POSTED)
    );
    assert_eq!(release_count(common::id(PLUS_ONE_BIND_DATA)), 1);

    drop(db);
    assert_eq!(release_count(common::id(PLUS_ONE_ID)), 1);
}

#[test]
fn table_function_runs_through_posted_path() {
    let _serial = serial();
    common::init();
    common::set_handler(handle);
    let db = Db::open();
    // SAFETY: the function is configured, registered, then destroyed once.
    unsafe {
        let mut function = ffi::duckdb_create_table_function();
        ffi::duckdb_table_function_set_name(function, c"seq_rows".as_ptr());
        callbacks::dbs_table_function_set_callbacks(function, common::id(SEQ_ID), true, true, true);
        assert_eq!(
            ffi::duckdb_register_table_function(db.connection, function),
            ffi::DuckDBSuccess
        );
        ffi::duckdb_destroy_table_function(&mut function);
    }
    let result = db
        .query("select count(*), sum(i)::bigint from seq_rows()")
        .expect("query");
    // SAFETY: live materialized result.
    unsafe {
        assert_eq!(ffi::duckdb_value_int64(result, 0, 0), SEQ_ROWS);
        assert_eq!(
            ffi::duckdb_value_int64(result, 1, 0),
            SEQ_ROWS * (SEQ_ROWS - 1) / 2
        );
    }
    free_result(result);
    for id in [SEQ_BIND_DATA, SEQ_INIT_DATA, SEQ_LOCAL_INIT_DATA] {
        assert_eq!(release_count(common::id(id)), 1, "id {id}");
    }
    drop(db);
    assert_eq!(release_count(common::id(SEQ_ID)), 1);
}

#[test]
fn copied_bind_data_releases_once() {
    let _serial = serial();
    common::init();
    let id = common::id(301);
    let original =
        Box::into_raw(Box::new(std::sync::Arc::new(callbacks::DataId(id)))).cast::<c_void>();
    // SAFETY: `original` is a live shared box; each box is destroyed once.
    unsafe {
        let copy = callbacks::copy_shared(original);
        assert_ne!(copy, original);
        assert_eq!(callbacks::read_shared(copy), id);
        callbacks::destroy_shared(original);
        assert_eq!(release_count(id), 0);
        callbacks::destroy_shared(copy);
    }
    assert_eq!(release_count(id), 1);
}

#[test]
fn counters_return_to_start() {
    let _serial = serial();
    common::init();
    let running = counters::get(counters::THREADS_RUNNING);
    let started = counters::get(counters::JOBS_STARTED);
    let completed = counters::get(counters::JOBS_COMPLETED);
    {
        let db = Db::open();
        for _ in 0..8 {
            free_result(db.query("select 1").expect("query"));
        }
        db.query("selec").expect_err("bad SQL");
    }
    // open + connect + 8 queries + 1 failing query.
    assert_eq!(counters::get(counters::JOBS_STARTED) - started, 11);
    assert_eq!(counters::get(counters::JOBS_COMPLETED) - completed, 11);
    assert_eq!(counters::get(counters::THREADS_RUNNING), running);
    assert!(counters::get(counters::THREADS_PEAK) >= 1);
    // SAFETY: the block is static and holds `COUNT` u64 values.
    let block = unsafe { std::slice::from_raw_parts(counters::dbs_counters(), counters::COUNT) };
    assert_eq!(
        block[counters::JOBS_STARTED],
        counters::get(counters::JOBS_STARTED)
    );
}
