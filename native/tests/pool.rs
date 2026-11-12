//! The job thread pool: the idle timeout, reuse, panics, and no concurrency cap.
//!
//! The pool is process-wide and counts its threads, so one test walks through every phase in
//! order, starting from an empty pool.

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Barrier, Mutex};
use std::thread::{self, ThreadId};
use std::time::{Duration, Instant};

use duckdb_bun_shim::pool;

fn submit(task: impl FnOnce() + Send + 'static) {
    assert!(pool::submit(Box::new(task)), "a pool thread runs the task");
}

fn report_thread(sender: &Sender<ThreadId>) -> impl FnOnce() + Send + 'static {
    let sender = sender.clone();
    move || sender.send(thread::current().id()).expect("send")
}

/// Waits until every pool thread is idle, so the next task finds one.
fn wait_idle() {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (threads, idle) = pool::sizes();
        if threads == idle {
            return;
        }
        assert!(Instant::now() < deadline, "pool threads stay busy");
        thread::sleep(Duration::from_millis(1));
    }
}

fn ran(receiver: &Receiver<ThreadId>) -> ThreadId {
    receiver.recv_timeout(Duration::from_secs(10)).expect("ran")
}

#[test]
fn pool_lifecycle() {
    let (sender, receiver) = channel();

    // Idle threads exit after the timeout.
    submit(report_thread(&sender));
    ran(&receiver);
    let deadline = Instant::now() + pool::IDLE_TIMEOUT + Duration::from_secs(5);
    while pool::sizes().0 > 0 {
        assert!(
            Instant::now() < deadline,
            "idle threads outlive the timeout"
        );
        thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(pool::sizes(), (0, 0));

    // Sequential jobs reuse one thread, named for the pool.
    let mut seen = Vec::new();
    for _ in 0..200 {
        submit(report_thread(&sender));
        seen.push(ran(&receiver));
        wait_idle();
    }
    seen.dedup();
    assert_eq!(seen.len(), 1, "every job ran on the same thread");
    assert_eq!(pool::sizes(), (1, 1));
    let name = Arc::new(Mutex::new(None));
    let write = name.clone();
    let done = sender.clone();
    submit(move || {
        *write.lock().expect("lock") = thread::current().name().map(str::to_owned);
        done.send(thread::current().id()).expect("send");
    });
    ran(&receiver);
    assert_eq!(
        name.lock().expect("lock").as_deref(),
        Some(pool::THREAD_NAME)
    );

    // A panicking job keeps its thread, which serves the next job.
    wait_idle();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    submit(|| panic!("job panics"));
    wait_idle();
    std::panic::set_hook(previous);
    submit(report_thread(&sender));
    assert_eq!(ran(&receiver), seen[0]);
    wait_idle();
    assert_eq!(pool::sizes(), (1, 1));

    // Concurrent jobs never wait for each other: each blocks until all run at once, which
    // deadlocks under any cap below the count.
    let count = 16;
    let barrier = Arc::new(Barrier::new(count));
    for _ in 0..count {
        let barrier = barrier.clone();
        let sender = sender.clone();
        submit(move || {
            barrier.wait();
            sender.send(thread::current().id()).expect("send");
        });
    }
    let mut ids: Vec<String> = (0..count)
        .map(|_| format!("{:?}", ran(&receiver)))
        .collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), count);
    assert_eq!(pool::sizes().0, count);
}
