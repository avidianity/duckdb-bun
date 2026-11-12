//! The native handles JavaScript owns, by kind, so a context can free what its
//! JS thread left behind when that thread goes away (`native/ABI.md`, "Handle
//! ownership").
//!
//! JavaScript reports each owned pointer with `dbs_own` and frees it with
//! `dbs_destroy`, which runs the same C destroy function the official binding's
//! finalizer runs. The context keeps the set; `runtime::close` frees whatever is
//! still in it once no native call of the context is running.

use std::ffi::c_void;

use libduckdb_sys as ffi;

use crate::jobs;
use crate::runtime;

pub const KIND_APPENDER: u32 = 1;
pub const KIND_CATALOG: u32 = 2;
pub const KIND_CATALOG_ENTRY: u32 = 3;
pub const KIND_CLIENT_CONTEXT: u32 = 4;
pub const KIND_CONFIG: u32 = 5;
pub const KIND_CONNECTION: u32 = 6;
pub const KIND_DATA_CHUNK: u32 = 7;
pub const KIND_DATABASE: u32 = 8;
pub const KIND_EXTRACTED_STATEMENTS: u32 = 9;
pub const KIND_INSTANCE_CACHE: u32 = 10;
pub const KIND_LOGICAL_TYPE: u32 = 11;
pub const KIND_PENDING_RESULT: u32 = 12;
pub const KIND_PREPARED_STATEMENT: u32 = 13;
/// A `duckdb_result *` allocated with `duckdb_malloc`.
pub const KIND_RESULT: u32 = 14;
pub const KIND_SCALAR_FUNCTION: u32 = 15;
pub const KIND_TABLE_FUNCTION: u32 = 16;
pub const KIND_VALUE: u32 = 17;
pub const KIND_VECTOR: u32 = 18;

/// The order a closing context frees its handles in: what borrows from a
/// connection or a database before the connection, connections before databases.
const FREE_ORDER: [u32; 18] = [
    KIND_DATA_CHUNK,
    KIND_VECTOR,
    KIND_VALUE,
    KIND_LOGICAL_TYPE,
    KIND_RESULT,
    KIND_PENDING_RESULT,
    KIND_PREPARED_STATEMENT,
    KIND_EXTRACTED_STATEMENTS,
    KIND_APPENDER,
    KIND_CATALOG_ENTRY,
    KIND_CATALOG,
    KIND_CLIENT_CONTEXT,
    KIND_SCALAR_FUNCTION,
    KIND_TABLE_FUNCTION,
    KIND_CONFIG,
    KIND_CONNECTION,
    KIND_DATABASE,
    KIND_INSTANCE_CACHE,
];

/// The position of `kind` in [`FREE_ORDER`]; unknown kinds go last.
pub(crate) fn free_rank(kind: u32) -> usize {
    FREE_ORDER
        .iter()
        .position(|&k| k == kind)
        .unwrap_or(FREE_ORDER.len())
}

/// Whether `kind` is one this module can free.
pub(crate) fn is_known(kind: u32) -> bool {
    FREE_ORDER.contains(&kind)
}

/// Frees `ptr` with the C destroy function of `kind`. Unknown kinds and null
/// pointers are ignored.
///
/// # Safety
///
/// `ptr` is null or a live handle of `kind` that nothing uses or frees afterwards.
pub(crate) unsafe fn destroy(kind: u32, ptr: usize) {
    if ptr == 0 {
        return;
    }
    let mut p = ptr as *mut c_void;
    // SAFETY: the caller hands over a live handle of `kind`; each arm calls that
    // kind's destroy function with the address of a local copy of the pointer.
    unsafe {
        match kind {
            KIND_APPENDER => {
                ffi::duckdb_appender_destroy(std::ptr::from_mut(&mut p).cast());
            }
            KIND_CATALOG => ffi::duckdb_destroy_catalog(std::ptr::from_mut(&mut p).cast()),
            KIND_CATALOG_ENTRY => {
                ffi::duckdb_destroy_catalog_entry(std::ptr::from_mut(&mut p).cast());
            }
            KIND_CLIENT_CONTEXT => {
                ffi::duckdb_destroy_client_context(std::ptr::from_mut(&mut p).cast());
            }
            KIND_CONFIG => ffi::duckdb_destroy_config(std::ptr::from_mut(&mut p).cast()),
            KIND_CONNECTION => ffi::duckdb_disconnect(std::ptr::from_mut(&mut p).cast()),
            KIND_DATA_CHUNK => ffi::duckdb_destroy_data_chunk(std::ptr::from_mut(&mut p).cast()),
            KIND_DATABASE => ffi::duckdb_close(std::ptr::from_mut(&mut p).cast()),
            KIND_EXTRACTED_STATEMENTS => {
                ffi::duckdb_destroy_extracted(std::ptr::from_mut(&mut p).cast());
            }
            KIND_INSTANCE_CACHE => {
                ffi::duckdb_destroy_instance_cache(std::ptr::from_mut(&mut p).cast());
            }
            KIND_LOGICAL_TYPE => {
                ffi::duckdb_destroy_logical_type(std::ptr::from_mut(&mut p).cast());
            }
            KIND_PENDING_RESULT => ffi::duckdb_destroy_pending(std::ptr::from_mut(&mut p).cast()),
            KIND_PREPARED_STATEMENT => {
                ffi::duckdb_destroy_prepare(std::ptr::from_mut(&mut p).cast());
            }
            KIND_RESULT => {
                ffi::duckdb_destroy_result(p.cast());
                ffi::duckdb_free(p);
            }
            KIND_SCALAR_FUNCTION => {
                ffi::duckdb_destroy_scalar_function(std::ptr::from_mut(&mut p).cast());
            }
            KIND_TABLE_FUNCTION => {
                ffi::duckdb_destroy_table_function(std::ptr::from_mut(&mut p).cast());
            }
            KIND_VALUE => ffi::duckdb_destroy_value(std::ptr::from_mut(&mut p).cast()),
            KIND_VECTOR => ffi::duckdb_destroy_vector(std::ptr::from_mut(&mut p).cast()),
            _ => {}
        }
    }
}

/// The handle kind a job's `out0` holds, by job op code (`jobs::OP_*`).
pub(crate) fn job_output_kind(op: u32) -> Option<u32> {
    match op {
        c if c == jobs::OP_OPEN.code || c == jobs::OP_GET_OR_CREATE_FROM_CACHE.code => {
            Some(KIND_DATABASE)
        }
        c if c == jobs::OP_CONNECT.code => Some(KIND_CONNECTION),
        c if c == jobs::OP_QUERY.code
            || c == jobs::OP_EXECUTE_PREPARED.code
            || c == jobs::OP_EXECUTE_PREPARED_STREAMING.code
            || c == jobs::OP_EXECUTE_PENDING.code =>
        {
            Some(KIND_RESULT)
        }
        c if c == jobs::OP_PREPARE.code || c == jobs::OP_PREPARE_EXTRACTED_STATEMENT.code => {
            Some(KIND_PREPARED_STATEMENT)
        }
        c if c == jobs::OP_EXTRACT_STATEMENTS.code => Some(KIND_EXTRACTED_STATEMENTS),
        c if c == jobs::OP_FETCH_CHUNK.code => Some(KIND_DATA_CHUNK),
        _ => None,
    }
}

/// Records that JavaScript owns `ptr`, a handle of `kind`, in the calling
/// thread's context. Null pointers and unknown kinds are ignored.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_own(kind: u32, ptr: *mut c_void) {
    if ptr.is_null() || !is_known(kind) {
        return;
    }
    runtime::own(ptr as usize, kind);
}

/// Frees a handle JavaScript owns, with the destroy function of `kind`.
///
/// In a thread with a context, only a pointer recorded by `dbs_own` and not yet
/// destroyed is freed, so a pointer is never freed twice. In a thread without
/// a context nothing was recorded, and the pointer is freed directly.
///
/// # Safety
///
/// `ptr` is null or a live handle of `kind` that JavaScript owns and no native
/// call uses.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_destroy(kind: u32, ptr: *mut c_void) {
    if ptr.is_null() || !is_known(kind) {
        return;
    }
    if runtime::disown(ptr as usize) {
        // SAFETY: the caller hands over a live handle of `kind`, and `disown`
        // removed it from the context, so the context will not free it again.
        unsafe { destroy(kind, ptr as usize) };
    }
}
