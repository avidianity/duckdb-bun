//! Before `dbs_init`, jobs do not start and function callbacks report an error
//! instead of crashing.

use std::ffi::{CStr, CString};
use std::ptr::null_mut;

use duckdb_bun_shim::callbacks;
use duckdb_bun_shim::jobs;
use libduckdb_sys as ffi;

#[test]
fn nothing_runs_before_init() {
    // SAFETY: handles are created, used on this thread, and destroyed once.
    unsafe {
        assert!(jobs::dbs_job_open(std::ptr::null(), 0, false, null_mut()).is_null());

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

        let mut function = ffi::duckdb_create_scalar_function();
        ffi::duckdb_scalar_function_set_name(function, c"orphan".as_ptr());
        let mut bigint = ffi::duckdb_create_logical_type(ffi::DUCKDB_TYPE_DUCKDB_TYPE_BIGINT);
        ffi::duckdb_scalar_function_add_parameter(function, bigint);
        ffi::duckdb_scalar_function_set_return_type(function, bigint);
        ffi::duckdb_destroy_logical_type(&mut bigint);
        callbacks::dbs_scalar_function_set_callbacks(function, 9, false, false);
        assert_eq!(
            ffi::duckdb_register_scalar_function(connection, function),
            ffi::DuckDBSuccess
        );
        ffi::duckdb_destroy_scalar_function(&mut function);

        let sql = CString::new("select orphan(1)").unwrap();
        let mut result: ffi::duckdb_result = std::mem::zeroed();
        assert_eq!(
            ffi::duckdb_query(connection, sql.as_ptr(), &mut result),
            ffi::DuckDBError
        );
        let message = CStr::from_ptr(ffi::duckdb_result_error(&mut result))
            .to_string_lossy()
            .into_owned();
        assert!(message.contains("before dbs_init"), "{message}");
        ffi::duckdb_destroy_result(&mut result);

        ffi::duckdb_disconnect(&mut connection);
        ffi::duckdb_close(&mut database);
    }
}
