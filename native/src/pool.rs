//! The native threads that run jobs: a cached pool shared by every JS thread.
//!
//! A job goes to an idle pool thread when one is waiting, and starts a new
//! thread otherwise, so the pool never caps concurrency: a long query never
//! makes a short one wait, as with one thread per job. A thread that stays idle
//! for `IDLE_TIMEOUT` exits. Reusing threads removes the cost of starting one
//! per call (thread creation, an 8 MiB stack mapping, an alternate signal stack
//! and the allocator's per-thread state), which dominated short calls such as
//! executing a prepared statement. ADR 0006 records the choice.

use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use crate::diag;

/// Stack size of every pool thread, as DuckDB's own threads get by default on Linux.
pub const STACK_SIZE: usize = 8 << 20;

/// The OS name of every pool thread; a running job sets its own name for crash reports.
pub const THREAD_NAME: &str = "duckdb-bun:pool";

/// How long a thread waits for a job before it exits.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(10);

/// A job's work, run once on a pool thread.
pub type Task = Box<dyn FnOnce() + Send + 'static>;

struct State {
    /// Tasks not yet taken by a thread.
    queue: VecDeque<Task>,
    /// Threads waiting for a task, including ones woken but not yet running.
    idle: usize,
    /// Threads alive, busy or idle.
    threads: usize,
}

struct Pool {
    state: Mutex<State>,
    wake: Condvar,
}

static POOL: Pool = Pool {
    state: Mutex::new(State {
        queue: VecDeque::new(),
        idle: 0,
        threads: 0,
    }),
    wake: Condvar::new(),
};

fn lock() -> MutexGuard<'static, State> {
    // A task never runs under the lock, so a poisoned lock still holds a consistent state.
    POOL.state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs `task` on a pool thread. Returns false, dropping `task` unrun, when no
/// thread is idle and a new one could not start.
pub fn submit(task: Task) -> bool {
    let mut state = lock();
    // Every idle thread beyond the queued tasks takes the next one.
    if state.idle > state.queue.len() {
        state.queue.push_back(task);
        drop(state);
        POOL.wake.notify_one();
        return true;
    }
    state.threads += 1;
    drop(state);

    let started = thread::Builder::new()
        .name(THREAD_NAME.to_owned())
        .stack_size(STACK_SIZE)
        .spawn(move || {
            diag::on_native_thread_start();
            run(task);
            serve();
        });
    if started.is_err() {
        lock().threads -= 1;
    }
    started.is_ok()
}

/// Runs one task. A panic is reported by the panic hook and does not end the thread.
fn run(task: Task) {
    let _ = catch_unwind(AssertUnwindSafe(task));
    diag::set_thread_name(THREAD_NAME.as_bytes());
}

/// Takes queued tasks until none arrives for `IDLE_TIMEOUT`.
fn serve() {
    let mut state = lock();
    loop {
        if let Some(task) = state.queue.pop_front() {
            drop(state);
            run(task);
            state = lock();
            continue;
        }
        state.idle += 1;
        let (next, timeout) = POOL
            .wake
            .wait_timeout(state, IDLE_TIMEOUT)
            .unwrap_or_else(PoisonError::into_inner);
        state = next;
        state.idle -= 1;
        if timeout.timed_out() && state.queue.is_empty() {
            state.threads -= 1;
            return;
        }
    }
}

/// Threads alive, and idle threads no queued job will take, for tests.
pub fn sizes() -> (usize, usize) {
    let state = lock();
    (state.threads, state.idle.saturating_sub(state.queue.len()))
}
