//! The JavaScript contexts registered with `dbs_init`: one per JS thread (the
//! main thread and each Worker that loads the bindings), each with its own
//! callbacks.
//!
//! A job completes to the context that started it. A function callback or an id
//! release goes to the context encoded in its id: JavaScript allocates every id
//! as `context << CONTEXT_SHIFT | local`, so a Worker's functions call back into
//! that Worker, as the official binding's per-env thread-safe functions do.
//!
//! A context also keeps what its JS thread would lose if the thread went away
//! without warning (a Worker stopped by `terminate()` runs no more script): the
//! native handles JavaScript owns, the jobs it started, the completions posted to
//! it and not yet freed, and the function callbacks blocked on it. Closing the
//! context (`dbs_context_close`, or the N-API cleanup hook in a Worker) stops
//! every call into the JS thread under the context's lock, releases the blocked
//! callbacks with an error, and, for a Worker, frees the handles once the last
//! job that uses them has returned (docs/adr/0008-a-worker-closes-its-context-in-an-n-api-cleanup-hook.md).

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};
use std::thread::{self, ThreadId};

use crate::callbacks::{Call, Signal};
use crate::counters;
use crate::handles;
use crate::jobs::{self, Job};

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

/// The state of one context. Every call into its JS thread happens with the
/// slot locked and `open` set, so once `close` has set `open` to false under the
/// lock, no call into that thread is running or can start.
struct Slot {
    context: Context,
    open: bool,
    /// Free the handles below once `running` reaches 0.
    reap: bool,
    /// The handles below were freed; nothing is recorded any more.
    reaped: bool,
    /// Jobs started and not yet past their completion.
    running: usize,
    /// Jobs posted to the JS thread and not yet freed by it.
    posted: HashSet<usize>,
    /// Handles JavaScript owns: pointer to kind (`handles::KIND_*`).
    owned: HashMap<usize, u32>,
    /// Function callbacks posted to the JS thread and still blocked, by call address.
    calls: HashMap<usize, Arc<Signal>>,
}

type SlotRef = Arc<Mutex<Slot>>;

/// Context `n` is at index `n - 1`; a context id is never reused.
static SLOTS: RwLock<Vec<SlotRef>> = RwLock::new(Vec::new());

thread_local! {
    /// The calling thread's context, set by `dbs_init`.
    static CURRENT: RefCell<Option<(u64, SlotRef)>> = const { RefCell::new(None) };
}

fn lock(slot: &SlotRef) -> MutexGuard<'_, Slot> {
    slot.lock().unwrap_or_else(PoisonError::into_inner)
}

fn slot(id: u64) -> Option<SlotRef> {
    let index = usize::try_from(id).ok()?.checked_sub(1)?;
    let slots = SLOTS.read().unwrap_or_else(PoisonError::into_inner);
    slots.get(index).cloned()
}

fn current_slot() -> Option<(u64, SlotRef)> {
    CURRENT.with(|current| current.borrow().clone())
}

/// The context with this id, or `None` when it is unknown or closed.
pub(crate) fn context(id: u64) -> Option<Context> {
    let slot = slot(id)?;
    let slot = lock(&slot);
    slot.open.then_some(slot.context)
}

/// The context an id belongs to.
pub(crate) fn context_of_id(id: u64) -> Option<Context> {
    context(id >> CONTEXT_SHIFT)
}

/// Runs `post` with the context `id` while holding it open, so `close` cannot
/// finish in between. Returns false, without calling `post`, when the context
/// is unknown or closed. `post` must not block.
pub(crate) fn post_to(id: u64, post: impl FnOnce(&Context)) -> bool {
    let Some(slot) = slot(id) else {
        return false;
    };
    let slot = lock(&slot);
    if slot.open {
        post(&slot.context);
        true
    } else {
        false
    }
}

/// Posts a function callback to the context `id` and records it as blocked, so
/// `close` can release it. Returns false when the context is unknown or closed.
pub(crate) fn post_call(id: u64, call: *mut Call, signal: &Arc<Signal>) -> bool {
    let Some(slot) = slot(id) else {
        return false;
    };
    let mut slot = lock(&slot);
    if !slot.open {
        return false;
    }
    (slot.context.on_call)(call);
    slot.calls.insert(call as usize, Arc::clone(signal));
    true
}

/// Takes the signal of a posted function callback that still waits, for
/// `dbs_call_done`. Looks in the calling thread's context first, then in all.
pub(crate) fn take_call(call: *mut Call) -> Option<Arc<Signal>> {
    let key = call as usize;
    if let Some((_, slot)) = current_slot()
        && let Some(signal) = lock(&slot).calls.remove(&key)
    {
        return Some(signal);
    }
    let slots: Vec<SlotRef> = SLOTS.read().unwrap_or_else(PoisonError::into_inner).clone();
    slots.iter().find_map(|slot| lock(slot).calls.remove(&key))
}

/// Forgets a posted function callback once its DuckDB thread has woken.
pub(crate) fn call_finished(id: u64, call: *mut Call) {
    if let Some(slot) = slot(id) {
        lock(&slot).calls.remove(&(call as usize));
    }
}

/// The id and context of the calling thread, or `None` when it has not called
/// `dbs_init` or its context is closed.
pub(crate) fn current() -> Option<(u64, Context)> {
    let (id, slot) = current_slot()?;
    let slot = lock(&slot);
    slot.open.then_some((id, slot.context))
}

/// Records a handle JavaScript owns in the calling thread's context.
pub(crate) fn own(ptr: usize, kind: u32) {
    if let Some((_, slot)) = current_slot() {
        let mut slot = lock(&slot);
        if !slot.reaped {
            slot.owned.insert(ptr, kind);
        }
    }
}

/// Removes a handle from the calling thread's context. Returns whether the
/// caller frees it: true when it was recorded, or when the thread has no context.
pub(crate) fn disown(ptr: usize) -> bool {
    match current_slot() {
        Some((_, slot)) => lock(&slot).owned.remove(&ptr).is_some(),
        None => true,
    }
}

/// Forgets a job JavaScript has freed.
pub(crate) fn job_freed(context: u64, job: *mut Job) {
    if let Some(slot) = slot(context) {
        lock(&slot).posted.remove(&(job as usize));
    }
}

/// A job counted as running in its context, from its start until its
/// completion is posted or dropped. While any job of a context runs, a closing
/// context does not free its handles, because the job may be using them.
pub struct JobTicket {
    context: u64,
    slot: SlotRef,
    done: bool,
}

impl JobTicket {
    /// Counts a new job in the calling thread's context, or returns `None` when
    /// the thread has no open context.
    pub(crate) fn acquire() -> Option<Self> {
        let (context, slot) = current_slot()?;
        {
            let mut guard = lock(&slot);
            if !guard.open {
                return None;
            }
            guard.running += 1;
        }
        Some(JobTicket {
            context,
            slot,
            done: false,
        })
    }

    /// Posts `job`, the outcome of a job with op code `op`, to the context's
    /// `on_complete`. A closed context never sees it: the job and its output are
    /// freed here. The last job of a closing context frees the context's handles.
    pub(crate) fn complete(mut self, job: *mut Job, op: u32) {
        self.done = true;
        // SAFETY: the job thread has exclusive access to `job` until it is posted.
        unsafe { jobs::set_origin(job, self.context, op) };
        let mut slot = lock(&self.slot);
        slot.running -= 1;
        let dropped = if slot.open {
            (slot.context.on_complete)(job);
            slot.posted.insert(job as usize);
            false
        } else {
            true
        };
        let reap = take_reap(&mut slot);
        drop(slot);
        if dropped {
            // SAFETY: no JavaScript holds the job, so this thread owns it and its output.
            unsafe { jobs::discard(job, &HashMap::new()) };
        }
        if let Some(reap) = reap {
            reap.run_counted();
        }
    }
}

impl Drop for JobTicket {
    /// A job that never ran (its thread could not start) stops counting.
    fn drop(&mut self) {
        if self.done {
            return;
        }
        let mut slot = lock(&self.slot);
        slot.running -= 1;
        let reap = take_reap(&mut slot);
        drop(slot);
        if let Some(reap) = reap {
            reap.run_counted();
        }
    }
}

/// What a closed context still owned, taken out of its slot to be freed outside the lock.
struct Reap {
    posted: Vec<usize>,
    owned: HashMap<usize, u32>,
}

impl Reap {
    /// Runs on a job thread, counted as a native thread running, so
    /// `diagnostics().nativeThreads.running` returns to its baseline only once
    /// the closed context's handles are freed.
    fn run_counted(self) {
        counters::thread_started();
        self.run();
        counters::thread_finished();
    }

    /// Frees the jobs JavaScript never freed (and their output, unless JavaScript
    /// took it), then every owned handle, borrowers before what they borrow from.
    fn run(self) {
        for job in self.posted {
            // SAFETY: the context is closed and reaped, so its JS thread runs no
            // more script and nothing else frees the job.
            unsafe { jobs::discard(job as *mut Job, &self.owned) };
        }
        let mut owned: Vec<(usize, u32)> = self.owned.into_iter().collect();
        owned.sort_by_key(|&(_, kind)| handles::free_rank(kind));
        for (ptr, kind) in owned {
            // SAFETY: JavaScript owned the handle, its thread runs no more
            // script, and no job of the context is running, so nothing uses it.
            unsafe { handles::destroy(kind, ptr) };
        }
    }
}

/// Takes what the slot owns when it is closed, asked to reap, and no job runs.
fn take_reap(slot: &mut Slot) -> Option<Reap> {
    if slot.open || !slot.reap || slot.reaped || slot.running > 0 {
        return None;
    }
    slot.reaped = true;
    Some(Reap {
        posted: slot.posted.drain().collect(),
        owned: std::mem::take(&mut slot.owned),
    })
}

/// Closes the calling thread's context: no more calls into its JS thread, and
/// blocked function callbacks are released with an error. With `reap`, the
/// context's connections are interrupted and its handles are freed once no job
/// of it runs, here or on the thread of the last job.
fn close_current(reap: bool) {
    let Some((_, slot)) = current_slot() else {
        return;
    };
    let mut guard = lock(&slot);
    if guard.open {
        guard.open = false;
        for signal in guard.calls.values() {
            signal.cancel();
        }
        guard.calls.clear();
    }
    let mut to_reap = None;
    if reap && !guard.reap {
        guard.reap = true;
        // Under the lock, so a job finishing meanwhile cannot free a connection
        // before it is interrupted.
        for (&ptr, &kind) in &guard.owned {
            if kind == handles::KIND_CONNECTION {
                // SAFETY: a live connection JavaScript owns; interrupting is
                // allowed while another thread runs a query on it.
                unsafe { libduckdb_sys::duckdb_interrupt(ptr as libduckdb_sys::duckdb_connection) };
            }
        }
        to_reap = take_reap(&mut guard);
    }
    drop(guard);
    if let Some(reap) = to_reap {
        reap.run();
    }
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
    if current().is_some() {
        return -2;
    }
    let slot = Arc::new(Mutex::new(Slot {
        context: Context {
            js_thread: thread::current().id(),
            on_complete,
            on_call,
            on_release,
            on_call_sync: None,
        },
        open: true,
        reap: false,
        reaped: false,
        running: 0,
        posted: HashSet::new(),
        owned: HashMap::new(),
        calls: HashMap::new(),
    }));
    let mut slots = SLOTS.write().unwrap_or_else(PoisonError::into_inner);
    if slots.len() >= MAX_CONTEXTS {
        return -3;
    }
    slots.push(Arc::clone(&slot));
    let id = slots.len();
    drop(slots);
    CURRENT.with(|current| *current.borrow_mut() = Some((id as u64, slot)));
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
    if let Some((_, slot)) = current_slot() {
        lock(&slot).context.on_call_sync = on_call_sync;
    }
}

/// Closes the calling thread's context before its JS thread goes away, as the
/// main thread does on its "exit" event. Later completions, callbacks and
/// releases for it are dropped instead of calling into a JS thread that no
/// longer runs script. The handles JavaScript owns stay as they are.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_context_close() {
    close_current(false);
}

/// Closes the calling thread's context and frees what it owns, as a Worker's
/// N-API cleanup hook does. Exported for tests; JavaScript never calls it.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_context_close_and_free() {
    close_current(true);
}

// --- N-API: the Worker's cleanup hook ---------------------------------------------

type NapiEnv = *mut c_void;
type NapiValue = *mut c_void;
type AddEnvCleanupHook =
    unsafe extern "C" fn(env: NapiEnv, hook: extern "C" fn(*mut c_void), arg: *mut c_void) -> i32;

thread_local! {
    /// Whether this thread's N-API environment has the cleanup hook.
    static HOOKED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

extern "C" fn cleanup_hook(_arg: *mut c_void) {
    close_current(true);
}

/// The N-API module entry point, run by `process.dlopen` once per JS thread
/// that loads the shim as an addon. It adds an environment cleanup hook that
/// closes this thread's context and frees what it owns. Bun runs a Worker's
/// cleanup hooks on the Worker's thread while its VM is still alive, on every
/// exit including `terminate()`. `napi_add_env_cleanup_hook` is looked up in the
/// running process, so the shim does not link against a Node-API host.
///
/// # Safety
///
/// Called by the runtime with a live `env` on the JS thread it belongs to.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_register_module_v1(env: NapiEnv, exports: NapiValue) -> NapiValue {
    // SAFETY: a NUL-terminated name looked up in the global scope.
    let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"napi_add_env_cleanup_hook".as_ptr()) };
    if symbol.is_null() || HOOKED.with(std::cell::Cell::get) {
        return exports;
    }
    // SAFETY: the symbol is Node-API's napi_add_env_cleanup_hook, whose C
    // signature `AddEnvCleanupHook` matches.
    let add: AddEnvCleanupHook = unsafe { std::mem::transmute(symbol) };
    // SAFETY: `env` is live; the hook takes no data.
    if unsafe { add(env, cleanup_hook, std::ptr::null_mut()) } == 0 {
        HOOKED.with(|hooked| hooked.set(true));
    }
    exports
}

/// Whether the calling thread's N-API environment has the cleanup hook.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_context_hooked() -> bool {
    HOOKED.with(std::cell::Cell::get)
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
