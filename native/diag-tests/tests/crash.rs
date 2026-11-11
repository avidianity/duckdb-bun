//! Runs `diag-crash` as a child process and checks the crash report it writes to stderr.

use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Output};

const HEADER_LINE: &str = "[duckdb-bun] package 0.0.0-test, duckdb v2.0.0, bun test, shim test\n";
const HOST_MARKER: &str = "[host] previous handler ran\n";

fn run(kind: u32, entries: u64, disable: bool) -> (Output, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_diag-crash"));
    command.arg(kind.to_string()).arg(entries.to_string());
    if disable {
        command.env("DUCKDB_BUN_CRASH_HANDLER", "0");
    } else {
        command.env_remove("DUCKDB_BUN_CRASH_HANDLER");
    }
    let output = command.output().expect("spawn diag-crash");
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    (output, stderr)
}

/// Asserts that each needle occurs in `haystack`, in the given order.
fn assert_in_order(haystack: &str, needles: &[&str]) {
    let mut from = 0;
    for needle in needles {
        match haystack[from..].find(needle) {
            Some(at) => from += at + needle.len(),
            None => panic!("missing {needle:?} after byte {from} in:\n{haystack}"),
        }
    }
}

fn assert_report(kind: u32, signals: &[(i32, &str)], thread: &str) {
    let (output, stderr) = run(kind, 3, false);
    let signal = output
        .status
        .signal()
        .unwrap_or_else(|| panic!("not killed by a signal: {:?}\n{stderr}", output.status));
    let name = signals
        .iter()
        .find(|(number, _)| *number == signal)
        .map(|(_, name)| *name)
        .unwrap_or_else(|| panic!("unexpected signal {signal}\n{stderr}"));
    let first_line = format!("[duckdb-bun] fatal signal {signal} ({name}) on thread {thread}\n");
    assert_in_order(
        &stderr,
        &[
            "ring entries written: 4\n",
            &first_line,
            HEADER_LINE,
            "[duckdb-bun] in flight: 2 native calls, 2 threads\n",
            "[duckdb-bun] last binding events, oldest first:\n",
            "[duckdb-bun]   #1 +0.",
            "s query start conn=1 handle=0xabc1 thread=0x",
            " text=\"select 1?from t\"\n",
            "[duckdb-bun]   #2 +0.",
            "s query start conn=2 handle=0xabc2 thread=0x",
            "[duckdb-bun]   #3 +0.",
            "s query start conn=3 handle=0xabc3 thread=0x",
            "[duckdb-bun]   #4 +0.",
            "s close event conn=7 handle=0xdead thread=0x",
            "[duckdb-bun] native backtrace:\n",
            HOST_MARKER,
        ],
    );
    assert_eq!(
        stderr.matches("[duckdb-bun] fatal signal").count(),
        1,
        "one report only:\n{stderr}"
    );
    assert!(
        !stderr.contains("ignored header"),
        "a second install must not replace the header"
    );
}

#[test]
fn null_dereference_prints_the_report_and_dies_by_the_signal() {
    assert_report(
        1,
        &[(libc::SIGSEGV, "SIGSEGV"), (libc::SIGBUS, "SIGBUS")],
        "js",
    );
}

#[test]
fn abort_prints_the_report_and_dies_by_sigabrt() {
    assert_report(2, &[(libc::SIGABRT, "SIGABRT")], "js");
}

#[test]
fn stack_overflow_on_a_native_thread_reports_on_the_alternate_stack() {
    assert_report(
        3,
        &[(libc::SIGSEGV, "SIGSEGV"), (libc::SIGBUS, "SIGBUS")],
        "duckdb-bun:crash-test",
    );
}

#[test]
fn the_ring_keeps_the_last_256_entries_oldest_first() {
    let (output, stderr) = run(1, 300, false);
    assert!(
        output.status.signal().is_some(),
        "not killed by a signal:\n{stderr}"
    );
    let events: Vec<&str> = stderr
        .lines()
        .filter(|line| line.starts_with("[duckdb-bun]   #"))
        .collect();
    assert_eq!(events.len(), 256, "{stderr}");
    assert!(
        events[0].starts_with("[duckdb-bun]   #46 "),
        "{}",
        events[0]
    );
    assert!(
        events[255].starts_with("[duckdb-bun]   #301 "),
        "{}",
        events[255]
    );
}

#[test]
fn crash_handler_env_zero_disables_it() {
    let (output, stderr) = run(1, 3, true);
    assert!(
        output.status.signal().is_some(),
        "not killed by a signal:\n{stderr}"
    );
    assert!(
        !stderr.contains("[duckdb-bun]"),
        "handler ran although disabled:\n{stderr}"
    );
    assert!(stderr.contains(HOST_MARKER), "{stderr}");
}
