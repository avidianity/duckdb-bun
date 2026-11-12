//! duckdb-bun native shim.
//!
//! A cdylib that `bun:ffi` loads beside libduckdb. It runs blocking DuckDB calls
//! on native threads, forwards scalar and table function callbacks to the JS
//! thread, and hands the binding the C++ exception boundary that every C API call
//! from JavaScript goes through (`cpp/`, `boundary`). The exported functions and
//! their contract are listed in `native/ABI.md`.

use std::ffi::{CStr, c_char};

pub mod boundary;
pub mod callbacks;
pub mod counters;
pub mod diag;
pub mod jobs;
pub mod pool;
pub mod runtime;

/// The shim's crate version, NUL-terminated.
const VERSION: &CStr =
    match CStr::from_bytes_with_nul(concat!(env!("CARGO_PKG_VERSION"), "\0").as_bytes()) {
        Ok(version) => version,
        Err(_) => panic!("crate version contains a NUL byte"),
    };

/// The shim's crate version, a static C string.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_version() -> *const c_char {
    VERSION.as_ptr()
}
