//! Process-wide state set by `dbs_init`: the JS thread and the JavaScript callbacks.

use std::sync::{OnceLock, PoisonError, RwLock};
use std::thread::{self, ThreadId};

use crate::callbacks::Call;
use crate::jobs::Job;

/// Thread-safe JSCallback that settles a job's Promise.
pub type CompleteFn = extern "C" fn(*mut Job);
/// Dispatcher for one function callback.
pub type CallFn = extern "C" fn(*mut Call);
/// Thread-safe JSCallback that releases a JavaScript object by id.
pub type ReleaseFn = extern "C" fn(u64);

pub(crate) struct Runtime {
    pub js_thread: ThreadId,
    pub on_complete: CompleteFn,
    pub on_call: CallFn,
    pub on_release: ReleaseFn,
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();
static SYNC_CALL: RwLock<Option<CallFn>> = RwLock::new(None);

/// The runtime, or `None` before `dbs_init`.
pub(crate) fn get() -> Option<&'static Runtime> {
    RUNTIME.get()
}

/// The dispatcher for function callbacks that run on the JS thread itself.
pub(crate) fn sync_call() -> Option<CallFn> {
    *SYNC_CALL.read().unwrap_or_else(PoisonError::into_inner)
}

/// Records the calling thread as the JS thread and stores the callbacks.
///
/// Returns 0 on success, 1 when the shim was already initialized (the first
/// callbacks stay), and 2 when a callback is null.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_init(
    on_complete: Option<CompleteFn>,
    on_call: Option<CallFn>,
    on_release: Option<ReleaseFn>,
) -> i32 {
    let (Some(on_complete), Some(on_call), Some(on_release)) = (on_complete, on_call, on_release)
    else {
        return 2;
    };
    let runtime = Runtime {
        js_thread: thread::current().id(),
        on_complete,
        on_call,
        on_release,
    };
    match RUNTIME.set(runtime) {
        Ok(()) => {
            crate::diag::set_counter_block(crate::counters::block());
            0
        }
        Err(_) => 1,
    }
}

/// Sets the non-thread-safe dispatcher used when DuckDB calls a function
/// callback on the JS thread. Null clears it.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_set_sync_call(on_call_sync: Option<CallFn>) {
    *SYNC_CALL.write().unwrap_or_else(PoisonError::into_inner) = on_call_sync;
}
