//! The C++ exception boundary (`cpp/boundary.hpp`, docs/adr/0003).
//!
//! Rust cannot catch a C++ exception, so the wrappers that catch one are C++,
//! compiled by build.rs. A cdylib exports only Rust's own symbols, so these
//! functions hand the binding their addresses and the per-thread exception state.

use std::ffi::{c_char, c_void};

unsafe extern "C" {
    fn dbs_cxx_capi_table(count: *mut usize) -> *const *const c_void;
    fn dbs_cxx_exception_flag() -> *mut i32;
    fn dbs_cxx_take_exception() -> *mut c_char;
}

/// The addresses of the C++ wrappers, in the order of
/// `src/bindings/generated/capi.ts` (`capi`, then `byValue`), and their count
/// through `count`.
///
/// # Safety
///
/// `count` points to writable memory for a `usize`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_capi_table(count: *mut usize) -> *const *const c_void {
    // SAFETY: the caller upholds this function's contract; the table is static.
    unsafe { dbs_cxx_capi_table(count) }
}

/// The calling thread's exception flag: nonzero after a wrapper caught a C++
/// exception that has not been taken. Valid for the life of the thread.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_exception_flag() -> *mut i32 {
    // SAFETY: returns the address of a thread-local; no preconditions.
    unsafe { dbs_cxx_exception_flag() }
}

/// Takes the calling thread's exception message and clears its flag. The caller
/// frees the message with `duckdb_free`; null when the exception had none.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_take_exception() -> *mut c_char {
    // SAFETY: no preconditions.
    unsafe { dbs_cxx_take_exception() }
}
