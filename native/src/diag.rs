//! Diagnostics stub: ring buffer and crash report.
//!
//! This is a no-op placeholder with the public API the rest of the crate uses.
//! The real implementation replaces this file.

/// Prepares a native thread the shim started (alternate signal stack, ring id).
pub fn on_native_thread_start() {}

/// Appends one ring entry.
pub fn record(_op: u32, _state: u32, _handle: u64, _connection_id: u64, _text: &[u8]) {}

/// Installs the fatal signal handlers. Returns 0 on success.
pub fn install_crash_handler(_header: &[u8]) -> i32 {
    0
}

/// Appends one ring entry on behalf of JavaScript.
///
/// # Safety
///
/// `text` points to `text_len` readable bytes, or `text_len` is 0.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_ring_record(
    _op: u32,
    _state: u32,
    _handle: u64,
    _connection_id: u64,
    _text: *const u8,
    _text_len: usize,
) {
}

/// Installs the fatal signal handlers. Returns 0 on success.
///
/// # Safety
///
/// `header` points to `header_len` readable bytes, or `header_len` is 0.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_install_crash_handler(_header: *const u8, _header_len: usize) -> i32 {
    0
}

/// Crashes the process on purpose. Test use only.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_crash_for_test(_kind: u32) {}
