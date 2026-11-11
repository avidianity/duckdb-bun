//! `diag-crash <kind> [entries]`: installs a stand-in for the host's crash handler, installs the
//! diag crash handler over it, records ring entries, then crashes with `dbs_crash_for_test(kind)`.
//!
//! The stand-in plays the role of Bun's own handler: it prints a marker, restores the default
//! action and re-raises, so the tests can see that the diag handler chains to it.

use std::ffi::{c_int, c_void};
use std::process::ExitCode;
use std::ptr;
use std::sync::atomic::AtomicU64;

use duckdb_bun_diag_tests::diag;

const HEADER: &str = "package 0.0.0-test, duckdb v2.0.0, bun test, shim test";

/// Stand-in counter block: 2 threads running, 5 jobs started, 3 completed.
static COUNTERS: [AtomicU64; 8] = [
    AtomicU64::new(2),
    AtomicU64::new(2),
    AtomicU64::new(5),
    AtomicU64::new(3),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
];

extern "C" fn host_handler(signal: c_int, _info: *mut libc::siginfo_t, _context: *mut c_void) {
    let marker = b"[host] previous handler ran\n";
    // SAFETY: `marker` is valid for its length; write is async-signal-safe.
    unsafe { libc::write(2, marker.as_ptr().cast(), marker.len()) };
    // SAFETY: SIG_DFL is a valid disposition; signal and raise are async-signal-safe.
    unsafe {
        libc::signal(signal, libc::SIG_DFL);
        libc::raise(signal);
    }
}

fn install_host_handler() {
    // SAFETY: zeroed sigaction is a valid empty action; the fields used are set below.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction =
        host_handler as extern "C" fn(c_int, *mut libc::siginfo_t, *mut c_void) as usize;
    action.sa_flags = libc::SA_SIGINFO | libc::SA_ONSTACK;
    for signal in [
        libc::SIGSEGV,
        libc::SIGBUS,
        libc::SIGILL,
        libc::SIGFPE,
        libc::SIGABRT,
    ] {
        // SAFETY: `action` is fully initialized and `host_handler` has the SA_SIGINFO shape.
        unsafe { libc::sigaction(signal, &action, ptr::null_mut()) };
    }
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(kind) = args.next().and_then(|arg| arg.parse::<u32>().ok()) else {
        eprintln!("usage: diag-crash <kind> [entries]");
        return ExitCode::from(64);
    };
    let entries = args
        .next()
        .and_then(|arg| arg.parse::<u64>().ok())
        .unwrap_or(3);

    install_host_handler();
    diag::set_counter_block(&COUNTERS);
    // SAFETY: HEADER is valid for its length for the duration of the call.
    let rc = unsafe { diag::dbs_install_crash_handler(HEADER.as_ptr(), HEADER.len()) };
    if rc != 0 {
        eprintln!("dbs_install_crash_handler returned {rc}");
        return ExitCode::from(65);
    }
    // A second install is a no-op.
    if diag::install_crash_handler(b"ignored header") != 0 {
        return ExitCode::from(66);
    }

    for index in 1..=entries {
        let text = format!("select {index}\nfrom t");
        // SAFETY: `text` is valid for its length for the duration of the call.
        unsafe { diag::dbs_ring_record(4, 1, 0xabc0 + index, index, text.as_ptr(), text.len()) };
    }
    diag::record(32, 4, 0xdead, 7, b"");
    eprintln!("ring entries written: {}", diag::ring_entries_written());

    diag::dbs_crash_for_test(kind);
    eprintln!("dbs_crash_for_test({kind}) returned");
    ExitCode::from(67)
}
