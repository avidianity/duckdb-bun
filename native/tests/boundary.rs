//! The C++ exception boundary (native/cpp/boundary.hpp): a wrapper whose C function
//! throws a C++ exception returns a zero value, and the calling thread's flag and
//! message hold the exception until the binding takes it.

use std::ffi::CStr;
use std::thread;

use duckdb_bun_shim::boundary::{dbs_capi_table, dbs_exception_flag, dbs_take_exception};
use libduckdb_sys as ffi;

unsafe extern "C" {
    fn dbs_cxx_to_date(date: *const ffi::duckdb_date_struct, out: *mut ffi::duckdb_date);
}

/// Calls the wrapper of `duckdb_to_date` for `parts` and returns its result.
fn to_date(year: i32, month: i8, day: i8) -> i32 {
    let parts = ffi::duckdb_date_struct { year, month, day };
    let mut out = ffi::duckdb_date { days: -1 };
    // SAFETY: both pointers are valid for the call.
    unsafe { dbs_cxx_to_date(&parts, &mut out) };
    out.days
}

/// The calling thread's flag.
fn flag() -> i32 {
    // SAFETY: the flag is a live thread-local of the calling thread.
    unsafe { *dbs_exception_flag() }
}

/// Takes the calling thread's exception message.
fn take() -> Option<String> {
    let message = dbs_take_exception();
    if message.is_null() {
        return None;
    }
    // SAFETY: a NUL-terminated string from duckdb_malloc, freed once below.
    let text = unsafe { CStr::from_ptr(message) }
        .to_string_lossy()
        .into_owned();
    // SAFETY: allocated with duckdb_malloc and not used after this.
    unsafe { ffi::duckdb_free(message.cast()) };
    Some(text)
}

#[test]
fn a_caught_exception_sets_the_flag_until_taken() {
    assert_eq!(to_date(1970, 1, 2), 1);
    assert_eq!(flag(), 0);

    // DuckDB throws a ConversionException for month 0; the wrapper writes a zero date.
    assert_eq!(to_date(2025, 0, 1), 0);
    assert_eq!(flag(), 1);
    let message = take().expect("the exception has a message");
    assert!(
        message.contains(r#""exception_type":"Conversion""#),
        "{message}"
    );
    assert!(message.contains("Date out of range: 2025-0-1"), "{message}");
    assert_eq!(flag(), 0);
    assert_eq!(take(), None);

    // A later exception replaces an untaken one.
    to_date(2025, 13, 1);
    to_date(2025, 0, 1);
    assert!(take().unwrap().contains("2025-0-1"));
}

#[test]
fn each_thread_has_its_own_flag() {
    to_date(2025, 0, 1);
    assert_eq!(flag(), 1);
    let other = thread::spawn(|| {
        let before = flag();
        to_date(2025, 0, 2);
        (before, take())
    })
    .join()
    .unwrap();
    assert_eq!(other.0, 0);
    assert!(other.1.unwrap().contains("2025-0-2"));
    assert!(take().unwrap().contains("2025-0-1"));
}

#[test]
fn the_table_holds_every_wrapper() {
    let mut count = 0usize;
    // SAFETY: `count` is writable.
    let table = unsafe { dbs_capi_table(&mut count) };
    assert!(count > 500, "{count} wrappers");
    // SAFETY: the table holds `count` entries.
    let entries = unsafe { std::slice::from_raw_parts(table, count) };
    assert!(entries.iter().all(|entry| !entry.is_null()));
    assert!(entries.contains(&(dbs_cxx_to_date as *const std::ffi::c_void)));
}
