//! The JavaScript contexts registered with `dbs_init`: one per JS thread (the
//! main thread and each Worker that loads the bindings), each with its own
//! callbacks.
//!
//! A job completes to the context that started it. A function callback or an id
//! release goes to the context encoded in its id: JavaScript allocates every id
//! as `context << CONTEXT_SHIFT | local`, so a Worker's functions call back into
//! that Worker, as the official binding's per-env thread-safe functions do.

use std::sync::{PoisonError, RwLock};
use std::thread::{self, ThreadId};

use crate::callbacks::Call;
use crate::jobs::Job;

/// Thread-safe JSCallback that settles a job's Promise.
pub type CompleteFn = extern "C" fn(*mut Job);
/// Dispatcher for one function callback.
pub type CallFn = extern "C" fn(*mut Call);
/// Thread-safe JSCallback that releases a JavaScript object by id.
pub type ReleaseFn = extern "C" fn(u64);

/// The bit where an id's context starts; the bits below are the context's own counter.
pub const CONTEXT_SHIFT: u32 = 40;
/// The most contexts one process registers, so a context id fits the 12 bits
/// above `CONTEXT_SHIFT` and every id stays below 2^53, exact as a JS number.
pub const MAX_CONTEXTS: usize = 4095;

/// One JS thread's callbacks.
#[derive(Clone, Copy)]
pub(crate) struct Context {
    pub js_thread: ThreadId,
    pub on_complete: CompleteFn,
    pub on_call: CallFn,
    pub on_release: ReleaseFn,
    pub on_call_sync: Option<CallFn>,
}

/// Context `n` is at index `n - 1`; a closed context leaves `None`, and its id is never reused.
static CONTEXTS: RwLock<Vec<Option<Context>>> = RwLock::new(Vec::new());

/// The context with this id, or `None` when it is unknown or closed.
pub(crate) fn context(id: u64) -> Option<Context> {
    let index = usize::try_from(id).ok()?.checked_sub(1)?;
    let contexts = CONTEXTS.read().unwrap_or_else(PoisonError::into_inner);
    contexts.get(index).copied().flatten()
}

/// The context an id belongs to.
pub(crate) fn context_of_id(id: u64) -> Option<Context> {
    context(id >> CONTEXT_SHIFT)
}

/// Runs `post` with the context `id` while holding it open, so `dbs_context_close`
/// cannot finish in between. Returns false, without calling `post`, when the
/// context is unknown or closed. `post` must not block.
pub(crate) fn post_to(id: u64, post: impl FnOnce(&Context)) -> bool {
    let Some(index) = usize::try_from(id).ok().and_then(|id| id.checked_sub(1)) else {
        return false;
    };
    let contexts = CONTEXTS.read().unwrap_or_else(PoisonError::into_inner);
    match contexts.get(index) {
        Some(Some(context)) => {
            post(context);
            true
        }
        _ => false,
    }
}

/// The id and context of the calling thread, or `None` when it has not called `dbs_init`.
pub(crate) fn current() -> Option<(u64, Context)> {
    let me = thread::current().id();
    let contexts = CONTEXTS.read().unwrap_or_else(PoisonError::into_inner);
    contexts
        .iter()
        .enumerate()
        .find_map(|(index, slot)| match slot {
            Some(context) if context.js_thread == me => Some((index as u64 + 1, *context)),
            _ => None,
        })
}

/// Registers the calling thread as a JS thread with its callbacks.
///
/// Returns the context id (1 to 4095), which JavaScript puts in the high bits of
/// every id it allocates. Returns -1 when a callback is null, -2 when the calling
/// thread already has an open context, and -3 when 4095 contexts were registered.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_init(
    on_complete: Option<CompleteFn>,
    on_call: Option<CallFn>,
    on_release: Option<ReleaseFn>,
) -> i32 {
    let (Some(on_complete), Some(on_call), Some(on_release)) = (on_complete, on_call, on_release)
    else {
        return -1;
    };
    let me = thread::current().id();
    let mut contexts = CONTEXTS.write().unwrap_or_else(PoisonError::into_inner);
    if contexts
        .iter()
        .flatten()
        .any(|context| context.js_thread == me)
    {
        return -2;
    }
    if contexts.len() >= MAX_CONTEXTS {
        return -3;
    }
    contexts.push(Some(Context {
        js_thread: me,
        on_complete,
        on_call,
        on_release,
        on_call_sync: None,
    }));
    let id = contexts.len();
    drop(contexts);
    crate::diag::set_counter_block(crate::counters::block());
    #[cfg(all(coverage, target_os = "linux"))]
    write_coverage_profile_at_quick_exit();
    i32::try_from(id).unwrap_or(-3)
}

/// Sets the calling context's non-thread-safe dispatcher, used when DuckDB calls
/// a function callback on that JS thread itself. Null clears it. A thread
/// without a context changes nothing.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_set_sync_call(on_call_sync: Option<CallFn>) {
    let me = thread::current().id();
    let mut contexts = CONTEXTS.write().unwrap_or_else(PoisonError::into_inner);
    if let Some(context) = contexts
        .iter_mut()
        .flatten()
        .find(|context| context.js_thread == me)
    {
        context.on_call_sync = on_call_sync;
    }
}

/// Closes the calling thread's context before its JS thread goes away, as a
/// Worker does when it exits. Later completions, callbacks and releases for it
/// are dropped instead of calling into a JS thread that no longer exists.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_context_close() {
    let me = thread::current().id();
    let mut contexts = CONTEXTS.write().unwrap_or_else(PoisonError::into_inner);
    for slot in contexts.iter_mut() {
        if slot.is_some_and(|context| context.js_thread == me) {
            *slot = None;
        }
    }
}

/// Coverage builds on Linux only (`cargo llvm-cov` sets `cfg(coverage)`). The profiler runtime
/// writes the coverage profile from an `atexit` hook, but Bun 1.4.4 ends a process on Linux with
/// `quick_exit` (`src/bun_core/Global.rs`), which runs only `at_quick_exit` hooks, so the shim's
/// profile from every Bun process was lost. Release builds do not contain this function.
#[cfg(all(coverage, target_os = "linux"))]
fn write_coverage_profile_at_quick_exit() {
    use std::ffi::c_int;
    use std::sync::Once;

    unsafe extern "C" {
        /// C11 and glibc: registers a function `quick_exit` calls.
        fn at_quick_exit(function: extern "C" fn()) -> c_int;
        /// Part of the LLVM profiler runtime that `-C instrument-coverage` links in.
        fn __llvm_profile_write_file() -> c_int;
    }
    extern "C" fn write() {
        // SAFETY: the profiler runtime is linked into every coverage build; the call takes no arguments.
        unsafe { __llvm_profile_write_file() };
    }
    static REGISTER: Once = Once::new();
    // SAFETY: `write` is a plain function that lives for the whole process.
    REGISTER.call_once(|| unsafe {
        at_quick_exit(write);
    });
}
