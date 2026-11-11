//! The counter block JavaScript reads through `dbs_counters` (see `native/ABI.md`).

use std::sync::atomic::{AtomicU64, Ordering};

/// Native threads running.
pub const THREADS_RUNNING: usize = 0;
/// Native threads peak.
pub const THREADS_PEAK: usize = 1;
/// Jobs started.
pub const JOBS_STARTED: usize = 2;
/// Jobs completed (callback posted).
pub const JOBS_COMPLETED: usize = 3;
/// Function callbacks posted to the JS thread.
pub const CALLS_POSTED: usize = 4;
/// Function callbacks completed.
pub const CALLS_COMPLETED: usize = 5;
/// Function callbacks run inline on the JS thread.
pub const CALLS_INLINE: usize = 6;
/// Ring entries written.
pub const RING_ENTRIES: usize = 7;

/// Number of counters in the block.
pub const COUNT: usize = 8;

// `AtomicU64` has the same in-memory representation as `u64`, so JavaScript can
// read the block as a `BigUint64Array`.
static COUNTERS: [AtomicU64; COUNT] = [const { AtomicU64::new(0) }; COUNT];

/// Adds `n` to the counter at `index`.
pub fn add(index: usize, n: u64) {
    COUNTERS[index].fetch_add(n, Ordering::Relaxed);
}

/// Subtracts `n` from the counter at `index`.
pub fn sub(index: usize, n: u64) {
    COUNTERS[index].fetch_sub(n, Ordering::Relaxed);
}

/// Reads the counter at `index`.
pub fn get(index: usize) -> u64 {
    COUNTERS[index].load(Ordering::Relaxed)
}

/// Counts a native thread as running and updates the peak.
pub fn thread_started() {
    let running = COUNTERS[THREADS_RUNNING].fetch_add(1, Ordering::Relaxed) + 1;
    COUNTERS[THREADS_PEAK].fetch_max(running, Ordering::Relaxed);
}

/// Counts a native thread as no longer running.
pub fn thread_finished() {
    sub(THREADS_RUNNING, 1);
}

/// Pointer to the static counter block, `COUNT` `u64` values.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_counters() -> *const u64 {
    COUNTERS.as_ptr().cast()
}
