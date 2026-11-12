//! Crash forensics: a lock-free ring of recent binding events, per-thread alternate signal
//! stacks, and a fatal-signal handler that prints both before it chains to the previous handler.
//!
//! The contract is `native/ABI.md`, section "Diagnostics: ring buffer and crash report".
//!
//! Everything the signal handler reads lives in static memory and is read with atomics, so the
//! handler never allocates, takes a lock, or touches thread-local storage. Thread-local storage
//! is avoided in the handler on purpose: in a library loaded with `dlopen`, the first access to a
//! thread-local on a thread may allocate (glibc `__tls_get_addr`, macOS `tlv_get_addr`), and the
//! crashing thread can be one the shim never started, such as a DuckDB worker.

use std::cell::{Cell, RefCell, UnsafeCell};
use std::ffi::{c_int, c_void};
use std::mem::MaybeUninit;
use std::ptr;
use std::sync::atomic::{
    AtomicBool, AtomicPtr, AtomicU8, AtomicU32, AtomicU64, AtomicUsize, Ordering, fence,
};

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
compile_error!("diag supports Linux and macOS only");

const PREFIX: &[u8] = b"[duckdb-bun] ";
const STDERR: c_int = 2;

// ---------------------------------------------------------------------------------------------
// Time and thread ids
// ---------------------------------------------------------------------------------------------

/// `CLOCK_MONOTONIC` reading of the module's first use; 0 until then.
static TIME_BASE_NS: AtomicU64 = AtomicU64::new(0);

fn monotonic_ns() -> u64 {
    let mut now = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `now` is a valid, writable timespec. Never called from the signal handler.
    let rc = unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) };
    if rc != 0 {
        return 0;
    }
    (now.tv_sec as u64)
        .saturating_mul(1_000_000_000)
        .saturating_add(now.tv_nsec as u64)
}

/// Nanoseconds since the module was first used. The first caller sets the base.
fn elapsed_ns() -> u64 {
    let now = monotonic_ns();
    match TIME_BASE_NS.compare_exchange(0, now, Ordering::Relaxed, Ordering::Relaxed) {
        Ok(_) => 0,
        Err(base) => now.saturating_sub(base),
    }
}

/// The OS thread id, read without thread-local storage, so it is usable in the signal handler.
#[cfg(target_os = "linux")]
fn os_thread_id() -> u64 {
    // SAFETY: gettid has no preconditions; it is a plain system call.
    let tid = unsafe { libc::gettid() };
    tid as u64
}

/// The OS thread id, read without thread-local storage, so it is usable in the signal handler.
#[cfg(target_os = "macos")]
fn os_thread_id() -> u64 {
    let mut tid: u64 = 0;
    // SAFETY: pthread_self() is the calling thread, and `tid` is a valid out pointer.
    unsafe { libc::pthread_threadid_np(libc::pthread_self(), &mut tid) };
    tid
}

thread_local! {
    static CACHED_THREAD_ID: Cell<u64> = const { Cell::new(0) };
}

/// The OS thread id, cached per thread; never called from the signal handler.
fn cached_thread_id() -> u64 {
    CACHED_THREAD_ID.with(|cached| {
        let mut tid = cached.get();
        if tid == 0 {
            tid = os_thread_id();
            cached.set(tid);
        }
        tid
    })
}

// ---------------------------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------------------------

const RING_LEN: usize = 256;
const TEXT_MAX: usize = 120;
const TEXT_WORDS: usize = TEXT_MAX / 8;
/// Set in `Entry::seq` while a writer owns the entry.
const WRITING: u64 = 1 << 63;

/// One ring entry. Every field is atomic, so concurrent readers and writers never race in the
/// language sense; `seq` is a seqlock marker that lets a reader detect a torn entry.
struct Entry {
    /// 0 when never written, `seq | WRITING` while written, the sequence number when complete.
    seq: AtomicU64,
    time_ns: AtomicU64,
    op_state: AtomicU64,
    thread_id: AtomicU64,
    handle: AtomicU64,
    connection_id: AtomicU64,
    text_len: AtomicU64,
    text: [AtomicU64; TEXT_WORDS],
}

impl Entry {
    const fn new() -> Self {
        Self {
            seq: AtomicU64::new(0),
            time_ns: AtomicU64::new(0),
            op_state: AtomicU64::new(0),
            thread_id: AtomicU64::new(0),
            handle: AtomicU64::new(0),
            connection_id: AtomicU64::new(0),
            text_len: AtomicU64::new(0),
            text: [const { AtomicU64::new(0) }; TEXT_WORDS],
        }
    }
}

static RING: [Entry; RING_LEN] = [const { Entry::new() }; RING_LEN];
/// The last sequence number handed out; sequence numbers start at 1.
static LAST_SEQ: AtomicU64 = AtomicU64::new(0);
static ENTRIES_WRITTEN: AtomicU64 = AtomicU64::new(0);

/// Appends one entry to the ring. Lock-free and wait-free: when two writers race for the same
/// slot (only possible when 256 other entries are written during one write), the older one is
/// dropped instead of waiting.
pub fn record(op: u32, state: u32, handle: u64, connection_id: u64, text: &[u8]) {
    let time_ns = elapsed_ns();
    let thread_id = cached_thread_id();
    let seq = LAST_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let entry = &RING[((seq - 1) % RING_LEN as u64) as usize];

    let current = entry.seq.load(Ordering::Relaxed);
    if current & WRITING != 0 || current >= seq {
        return;
    }
    if entry
        .seq
        .compare_exchange(current, seq | WRITING, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    // Orders the WRITING marker before the field stores, as in a seqlock writer.
    fence(Ordering::Release);

    let text = &text[..text.len().min(TEXT_MAX)];
    entry.time_ns.store(time_ns, Ordering::Relaxed);
    entry
        .op_state
        .store((u64::from(op) << 32) | u64::from(state), Ordering::Relaxed);
    entry.thread_id.store(thread_id, Ordering::Relaxed);
    entry.handle.store(handle, Ordering::Relaxed);
    entry.connection_id.store(connection_id, Ordering::Relaxed);
    entry.text_len.store(text.len() as u64, Ordering::Relaxed);
    for (word, chunk) in entry.text.iter().zip(text.chunks(8)) {
        let mut bytes = [0u8; 8];
        bytes[..chunk.len()].copy_from_slice(chunk);
        word.store(u64::from_ne_bytes(bytes), Ordering::Relaxed);
    }

    entry.seq.store(seq, Ordering::Release);
    ENTRIES_WRITTEN.fetch_add(1, Ordering::Relaxed);
    let block = COUNTERS.load(Ordering::Acquire);
    if !block.is_null() {
        // SAFETY: `set_counter_block` only stores the address of a `&'static [AtomicU64; 8]`,
        // so index 7 is in bounds and lives for the rest of the process.
        unsafe { (*block.add(COUNTER_RING_ENTRIES)).fetch_add(1, Ordering::Relaxed) };
    }
}

/// Complete entries written so far; counter index 7 in the shim's counter block.
pub fn ring_entries_written() -> u64 {
    ENTRIES_WRITTEN.load(Ordering::Relaxed)
}

/// A consistent copy of one entry, taken by `read_entry`.
struct Snapshot {
    seq: u64,
    time_ns: u64,
    op: u32,
    state: u32,
    thread_id: u64,
    handle: u64,
    connection_id: u64,
    text_len: usize,
    text: [u8; TEXT_MAX],
}

/// Reads the entry holding sequence number `seq`, or `None` when the slot holds another entry,
/// is being written, or changed while it was read. Async-signal-safe.
fn read_entry(seq: u64) -> Option<Snapshot> {
    let entry = &RING[((seq.wrapping_sub(1)) % RING_LEN as u64) as usize];
    if entry.seq.load(Ordering::Acquire) != seq {
        return None;
    }
    let op_state = entry.op_state.load(Ordering::Relaxed);
    let mut snapshot = Snapshot {
        seq,
        time_ns: entry.time_ns.load(Ordering::Relaxed),
        op: (op_state >> 32) as u32,
        state: op_state as u32,
        thread_id: entry.thread_id.load(Ordering::Relaxed),
        handle: entry.handle.load(Ordering::Relaxed),
        connection_id: entry.connection_id.load(Ordering::Relaxed),
        text_len: (entry.text_len.load(Ordering::Relaxed) as usize).min(TEXT_MAX),
        text: [0u8; TEXT_MAX],
    };
    for (chunk, word) in snapshot.text.chunks_mut(8).zip(entry.text.iter()) {
        chunk.copy_from_slice(&word.load(Ordering::Relaxed).to_ne_bytes());
    }
    // Orders the field loads before the re-check, as in a seqlock reader.
    fence(Ordering::Acquire);
    if entry.seq.load(Ordering::Relaxed) != seq {
        return None;
    }
    Some(snapshot)
}

/// Op names from ABI.md: the job ops in table order from 1, then the JavaScript-recorded events.
fn op_name(op: u32) -> &'static str {
    match op {
        1 => "open",
        2 => "get_or_create_from_cache",
        3 => "connect",
        4 => "query",
        5 => "prepare",
        6 => "execute_prepared",
        7 => "execute_prepared_streaming",
        8 => "extract_statements",
        9 => "prepare_extracted_statement",
        10 => "execute_pending",
        11 => "fetch_chunk",
        32 => "close",
        33 => "disconnect",
        34 => "destroy_result",
        35 => "destroy_pending",
        36 => "destroy_prepared",
        37 => "interrupt",
        38 => "register_scalar_function",
        39 => "register_table_function",
        40 => "appender_flush",
        41 => "appender_close",
        42 => "pending_execute_task",
        _ => "unknown_op",
    }
}

fn state_name(state: u32) -> &'static str {
    match state {
        1 => "start",
        2 => "end ok",
        3 => "end error",
        4 => "event",
        _ => "unknown_state",
    }
}

// ---------------------------------------------------------------------------------------------
// Thread names, in a static table keyed by OS thread id
// ---------------------------------------------------------------------------------------------

const NAME_SLOTS: usize = 256;
const NAME_MAX: usize = 63;
/// `NameSlot::owner` value while a thread fills the slot.
const CLAIMING: u64 = u64::MAX;

struct NameSlot {
    /// 0 when free, `CLAIMING` while filled, else the owning thread's OS id.
    owner: AtomicU64,
    len: AtomicUsize,
    name: [AtomicU8; NAME_MAX],
}

impl NameSlot {
    const fn new() -> Self {
        Self {
            owner: AtomicU64::new(0),
            len: AtomicUsize::new(0),
            name: [const { AtomicU8::new(0) }; NAME_MAX],
        }
    }
}

static NAMES: [NameSlot; NAME_SLOTS] = [const { NameSlot::new() }; NAME_SLOTS];

/// Stores `name` for the calling thread. Returns the slot, or `None` when the table is full.
fn register_thread_name(name: &[u8]) -> Option<usize> {
    let tid = os_thread_id();
    let name = &name[..name.len().min(NAME_MAX)];
    for (index, slot) in NAMES.iter().enumerate() {
        if slot
            .owner
            .compare_exchange(0, CLAIMING, Ordering::Acquire, Ordering::Relaxed)
            .is_ok()
        {
            for (cell, byte) in slot.name.iter().zip(name) {
                cell.store(*byte, Ordering::Relaxed);
            }
            slot.len.store(name.len(), Ordering::Relaxed);
            slot.owner.store(tid, Ordering::Release);
            return Some(index);
        }
    }
    None
}

fn release_thread_name(index: usize) {
    if let Some(slot) = NAMES.get(index) {
        slot.owner.store(0, Ordering::Release);
    }
}

/// Copies the calling thread's name into `out` and returns its length, 0 when unnamed.
/// Async-signal-safe: static memory and atomics only.
fn lookup_thread_name(tid: u64, out: &mut [u8; NAME_MAX]) -> usize {
    for slot in &NAMES {
        if slot.owner.load(Ordering::Acquire) == tid {
            let len = slot.len.load(Ordering::Relaxed).min(NAME_MAX);
            for (byte, cell) in out.iter_mut().zip(&slot.name).take(len) {
                *byte = cell.load(Ordering::Relaxed);
            }
            return len;
        }
    }
    0
}

// ---------------------------------------------------------------------------------------------
// Alternate signal stacks
// ---------------------------------------------------------------------------------------------

/// Usable bytes of an alternate signal stack: at least max(SIGSTKSZ, 64 KiB), plus the kernel's
/// dynamic minimum signal frame on Linux (`AT_MINSIGSTKSZ`, larger with AVX-512 state).
fn alt_stack_size(page: usize) -> usize {
    let base = libc::SIGSTKSZ.max(64 * 1024);
    #[cfg(target_os = "linux")]
    // SAFETY: getauxval has no preconditions; it returns 0 when the entry is absent.
    let dynamic = unsafe { libc::getauxval(libc::AT_MINSIGSTKSZ) } as usize;
    #[cfg(not(target_os = "linux"))]
    let dynamic = 0usize;
    (base + dynamic).div_ceil(page) * page
}

fn page_size() -> usize {
    // SAFETY: sysconf has no preconditions.
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page > 0 { page as usize } else { 4096 }
}

/// An `mmap`ed alternate signal stack with a guard page below it, installed for one thread.
struct AltStack {
    mapping: *mut c_void,
    mapping_len: usize,
    stack: *mut c_void,
    stack_len: usize,
}

impl AltStack {
    /// Maps a new stack and installs it as the calling thread's alternate signal stack.
    fn install() -> Option<Self> {
        let page = page_size();
        let stack_len = alt_stack_size(page);
        let mapping_len = stack_len + page;
        #[cfg(target_os = "linux")]
        let flags = libc::MAP_PRIVATE | libc::MAP_ANONYMOUS | libc::MAP_STACK;
        #[cfg(not(target_os = "linux"))]
        let flags = libc::MAP_PRIVATE | libc::MAP_ANON;
        // SAFETY: an anonymous private mapping at a kernel-chosen address touches no existing memory.
        let mapping = unsafe {
            libc::mmap(
                ptr::null_mut(),
                mapping_len,
                libc::PROT_READ | libc::PROT_WRITE,
                flags,
                -1,
                0,
            )
        };
        if mapping == libc::MAP_FAILED {
            return None;
        }
        let stack = Self {
            mapping,
            mapping_len,
            stack: mapping.wrapping_byte_add(page),
            stack_len,
        };
        // SAFETY: the first page lies inside the mapping made above.
        if unsafe { libc::mprotect(mapping, page, libc::PROT_NONE) } != 0 {
            return None; // Drop unmaps.
        }
        let descriptor = libc::stack_t {
            ss_sp: stack.stack,
            ss_flags: 0,
            ss_size: stack.stack_len,
        };
        // SAFETY: `descriptor` describes writable memory this struct owns until it is dropped.
        if unsafe { libc::sigaltstack(&descriptor, ptr::null_mut()) } != 0 {
            return None;
        }
        Some(stack)
    }
}

impl Drop for AltStack {
    fn drop(&mut self) {
        let mut current = MaybeUninit::<libc::stack_t>::zeroed();
        // SAFETY: a null new stack only queries; `current` is a valid out pointer.
        let queried = unsafe { libc::sigaltstack(ptr::null(), current.as_mut_ptr()) } == 0;
        // SAFETY: zero-initialized and possibly overwritten by sigaltstack; stack_t is plain data.
        let current = unsafe { current.assume_init() };
        if queried && current.ss_sp == self.stack && current.ss_flags & libc::SS_DISABLE == 0 {
            // macOS rejects SS_DISABLE with ss_size below MINSIGSTKSZ, so pass the real size.
            let disable = libc::stack_t {
                ss_sp: ptr::null_mut(),
                ss_flags: libc::SS_DISABLE,
                ss_size: self.stack_len,
            };
            // SAFETY: disabling the alternate stack of the calling thread, which this struct installed.
            unsafe { libc::sigaltstack(&disable, ptr::null_mut()) };
        }
        // SAFETY: `mapping` and `mapping_len` are exactly the region mmap returned, no longer in use.
        unsafe { libc::munmap(self.mapping, self.mapping_len) };
    }
}

/// Per-thread diagnostics state; dropping it on thread exit frees the stack and the name slot.
struct ThreadDiag {
    _alt_stack: Option<AltStack>,
    name_slot: Option<usize>,
}

impl Drop for ThreadDiag {
    fn drop(&mut self) {
        if let Some(index) = self.name_slot {
            release_thread_name(index);
        }
    }
}

thread_local! {
    static THREAD_DIAG: RefCell<Option<ThreadDiag>> = const { RefCell::new(None) };
}

/// Call first thing on every native thread the shim starts. Installs an alternate signal stack
/// for the thread and records its name for the crash report; both are released on thread exit.
/// Idempotent per thread.
pub fn on_native_thread_start() {
    elapsed_ns();
    THREAD_DIAG.with(|state| {
        let mut state = state.borrow_mut();
        if state.is_some() {
            return;
        }
        let name_slot = std::thread::current()
            .name()
            .and_then(|name| register_thread_name(name.as_bytes()));
        *state = Some(ThreadDiag {
            _alt_stack: AltStack::install(),
            name_slot,
        });
    });
}

/// Replaces the calling thread's name in the crash report, as a pool thread does for each job.
/// Does not allocate. A thread without a slot (not started through `on_native_thread_start`, or
/// the table was full) takes one now when a slot is free.
pub fn set_thread_name(name: &[u8]) {
    let name = &name[..name.len().min(NAME_MAX)];
    THREAD_DIAG.with(|state| {
        let mut state = state.borrow_mut();
        let Some(diag) = state.as_mut() else {
            return;
        };
        match diag.name_slot.and_then(|index| NAMES.get(index)) {
            Some(slot) => {
                // A crash report reads only the crashing thread's own slot. Zeroing the length
                // first means a signal during the copy reports no name rather than a mixed one.
                slot.len.store(0, Ordering::Relaxed);
                for (cell, byte) in slot.name.iter().zip(name) {
                    cell.store(*byte, Ordering::Relaxed);
                }
                slot.len.store(name.len(), Ordering::Release);
            }
            None => diag.name_slot = register_thread_name(name),
        }
    });
}

// ---------------------------------------------------------------------------------------------
// Crash handler installation
// ---------------------------------------------------------------------------------------------

const FATAL_SIGNALS: [c_int; 5] = [
    libc::SIGSEGV,
    libc::SIGBUS,
    libc::SIGILL,
    libc::SIGFPE,
    libc::SIGABRT,
];

/// `install_crash_handler` return codes.
pub const CRASH_HANDLER_OK: i32 = 0;
/// The alternate signal stack for the calling thread could not be mapped or installed.
pub const CRASH_HANDLER_ALT_STACK_FAILED: i32 = 1;
/// `sigaction` failed; any handler installed by this call was rolled back.
pub const CRASH_HANDLER_SIGACTION_FAILED: i32 = 2;

const INSTALL_NONE: u32 = 0;
const INSTALL_BUSY: u32 = 1;
const INSTALL_DONE: u32 = 2;
static INSTALL_STATE: AtomicU32 = AtomicU32::new(INSTALL_NONE);

const HEADER_MAX: usize = 512;
static HEADER: [AtomicU8; HEADER_MAX] = [const { AtomicU8::new(0) }; HEADER_MAX];
static HEADER_LEN: AtomicUsize = AtomicUsize::new(0);

static COUNTERS: AtomicPtr<AtomicU64> = AtomicPtr::new(ptr::null_mut());
/// Index of "ring entries written" in the shim's counter block (ABI.md).
const COUNTER_RING_ENTRIES: usize = 7;

/// The signal actions in place before ours, written once by the installing thread before our
/// handler is installed for that signal, then only read.
struct PreviousActions {
    actions: UnsafeCell<[MaybeUninit<libc::sigaction>; FATAL_SIGNALS.len()]>,
    saved: [AtomicBool; FATAL_SIGNALS.len()],
}

// SAFETY: each `actions[i]` is written only by the one thread that wins INSTALL_STATE, before
// `saved[i]` is set with Release; readers load `saved[i]` with Acquire before reading it.
unsafe impl Sync for PreviousActions {}

static PREVIOUS: PreviousActions = PreviousActions {
    actions: UnsafeCell::new([const { MaybeUninit::uninit() }; FATAL_SIGNALS.len()]),
    saved: [const { AtomicBool::new(false) }; FATAL_SIGNALS.len()],
};

/// Registers the shim's 8-counter block (ABI.md "Counters") so the crash report
/// can print the native calls and threads in flight.
pub fn set_counter_block(block: &'static [AtomicU64; 8]) {
    COUNTERS.store(block.as_ptr().cast_mut(), Ordering::Release);
}

/// Installs the fatal-signal handler. Copies `header` (one line, without the prefix), installs an
/// alternate signal stack for the calling thread (the JS thread, kept for the process lifetime),
/// warms up `backtrace`, and installs handlers for SIGSEGV, SIGBUS, SIGILL, SIGFPE and SIGABRT.
/// Idempotent. Does nothing when the environment has `DUCKDB_BUN_CRASH_HANDLER=0`.
pub fn install_crash_handler(header: &[u8]) -> i32 {
    if std::env::var_os("DUCKDB_BUN_CRASH_HANDLER").is_some_and(|value| value == "0") {
        return CRASH_HANDLER_OK;
    }
    if INSTALL_STATE
        .compare_exchange(
            INSTALL_NONE,
            INSTALL_BUSY,
            Ordering::Acquire,
            Ordering::Acquire,
        )
        .is_err()
    {
        return CRASH_HANDLER_OK;
    }
    elapsed_ns();

    let mut header = header;
    while let [rest @ .., b'\n' | b'\r'] = header {
        header = rest;
    }
    let header = &header[..header.len().min(HEADER_MAX)];
    for (cell, byte) in HEADER.iter().zip(header) {
        cell.store(*byte, Ordering::Relaxed);
    }
    HEADER_LEN.store(header.len(), Ordering::Release);

    // The JS thread lives as long as the process, so its stack and name are never released.
    let Some(stack) = AltStack::install() else {
        INSTALL_STATE.store(INSTALL_NONE, Ordering::Release);
        return CRASH_HANDLER_ALT_STACK_FAILED;
    };
    std::mem::forget(stack);
    register_thread_name(b"js");

    // glibc loads libgcc_s on the first backtrace call, which is not async-signal-safe.
    let mut frames = [ptr::null_mut::<c_void>(); 4];
    // SAFETY: `frames` has room for the 4 entries requested.
    unsafe { libc::backtrace(frames.as_mut_ptr(), frames.len() as c_int) };

    // SAFETY: zeroed sigaction is a valid empty action on both platforms; fields are set below.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction =
        handle_fatal_signal as extern "C" fn(c_int, *mut libc::siginfo_t, *mut c_void) as usize;
    action.sa_flags = libc::SA_SIGINFO | libc::SA_ONSTACK;
    // SAFETY: `action.sa_mask` is a valid sigset_t to initialize.
    unsafe { libc::sigemptyset(&mut action.sa_mask) };

    for (index, &signal) in FATAL_SIGNALS.iter().enumerate() {
        // SAFETY: this thread won INSTALL_STATE, so it is the only writer of `actions`, and no
        // reader looks at `actions[index]` until `saved[index]` is set below.
        let slot = unsafe { (*PREVIOUS.actions.get())[index].as_mut_ptr() };
        // SAFETY: a null new action only queries; `slot` is valid for writes.
        let queried = unsafe { libc::sigaction(signal, ptr::null(), slot) } == 0;
        if queried {
            PREVIOUS.saved[index].store(true, Ordering::Release);
        }
        // SAFETY: `action` is fully initialized and `handle_fatal_signal` has the SA_SIGINFO shape.
        if !queried || unsafe { libc::sigaction(signal, &action, ptr::null_mut()) } != 0 {
            restore_previous(&FATAL_SIGNALS[..index]);
            INSTALL_STATE.store(INSTALL_NONE, Ordering::Release);
            return CRASH_HANDLER_SIGACTION_FAILED;
        }
    }
    INSTALL_STATE.store(INSTALL_DONE, Ordering::Release);
    CRASH_HANDLER_OK
}

/// Puts back the saved action for each of `signals`, or SIG_DFL when none was saved.
/// Async-signal-safe.
fn restore_previous(signals: &[c_int]) {
    for &signal in signals {
        let Some(index) = FATAL_SIGNALS.iter().position(|&fatal| fatal == signal) else {
            continue;
        };
        if PREVIOUS.saved[index].load(Ordering::Acquire) {
            // SAFETY: `saved[index]` is set, so `actions[index]` is initialized and never written again.
            let previous = unsafe { (*PREVIOUS.actions.get())[index].as_ptr() };
            // SAFETY: `previous` points to a valid sigaction saved by install_crash_handler.
            unsafe { libc::sigaction(signal, previous, ptr::null_mut()) };
        } else {
            // SAFETY: SIG_DFL with an empty mask is a valid action.
            unsafe { libc::signal(signal, libc::SIG_DFL) };
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The signal handler and its async-signal-safe output
// ---------------------------------------------------------------------------------------------

/// Thread id of the thread printing the report; 0 while no report has started.
static REPORTER: AtomicU64 = AtomicU64::new(0);
static REPORT_DONE: AtomicBool = AtomicBool::new(false);

extern "C" fn handle_fatal_signal(
    signal: c_int,
    _info: *mut libc::siginfo_t,
    _context: *mut c_void,
) {
    let tid = os_thread_id();
    match REPORTER.compare_exchange(0, tid, Ordering::AcqRel, Ordering::Acquire) {
        Ok(_) => {
            write_report(signal, tid);
            REPORT_DONE.store(true, Ordering::Release);
        }
        // A second fatal signal inside our own report: chain without printing again.
        Err(owner) if owner == tid => {}
        // Another thread is reporting: give it up to 2 s to finish before chaining.
        Err(_) => {
            for _ in 0..2 {
                if REPORT_DONE.load(Ordering::Acquire) {
                    break;
                }
                // SAFETY: sleep is on the async-signal-safe lists of signal-safety(7) and macOS
                // sigaction(2); nanosleep is not on either.
                unsafe { libc::sleep(1) };
            }
        }
    }
    restore_previous(&[signal]);
    #[cfg(coverage)]
    write_coverage_profile();
    // The signal is blocked while this handler runs, so the re-raised signal stays pending and is
    // delivered to the previous action as soon as this handler returns.
    // SAFETY: raise is async-signal-safe (POSIX).
    unsafe { libc::raise(signal) };
}

/// Coverage builds only (`cargo llvm-cov` sets `cfg(coverage)`): writes this process's coverage
/// profile before the signal kills it. The profiler runtime writes the profile from an `atexit`
/// hook, which a process dying of a signal never runs, so without this call the crash report
/// code would count as unexecuted. Writing the profile is not async-signal-safe; that is accepted
/// in a coverage build, and release builds do not contain this function.
#[cfg(coverage)]
fn write_coverage_profile() {
    unsafe extern "C" {
        /// Part of the LLVM profiler runtime that `-C instrument-coverage` links in.
        fn __llvm_profile_write_file() -> c_int;
    }
    // SAFETY: the profiler runtime is linked into every coverage build; the call takes no arguments.
    unsafe { __llvm_profile_write_file() };
}

fn signal_name(signal: c_int) -> &'static str {
    match signal {
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGBUS => "SIGBUS",
        libc::SIGILL => "SIGILL",
        libc::SIGFPE => "SIGFPE",
        libc::SIGABRT => "SIGABRT",
        _ => "unknown",
    }
}

fn write_report(signal: c_int, tid: u64) {
    let mut out = Output::new();

    out.bytes(PREFIX);
    out.bytes(b"fatal signal ");
    out.decimal(signal as u64);
    out.bytes(b" (");
    out.bytes(signal_name(signal).as_bytes());
    out.bytes(b") on thread ");
    let mut name = [0u8; NAME_MAX];
    let name_len = lookup_thread_name(tid, &mut name);
    if name_len > 0 {
        out.bytes(&name[..name_len]);
    } else {
        out.hex(tid);
    }
    out.line_end();

    let header_len = HEADER_LEN.load(Ordering::Acquire).min(HEADER_MAX);
    if header_len > 0 {
        out.bytes(PREFIX);
        for cell in HEADER.iter().take(header_len) {
            out.byte(cell.load(Ordering::Relaxed));
        }
        out.line_end();
    }

    let counters = COUNTERS.load(Ordering::Acquire);
    if !counters.is_null() {
        // SAFETY: set_counter_block only stores pointers to a `&'static [AtomicU64; 8]`.
        let block = unsafe { &*counters.cast::<[AtomicU64; 8]>() };
        let threads = block[0].load(Ordering::Relaxed);
        let calls = block[2]
            .load(Ordering::Relaxed)
            .saturating_sub(block[3].load(Ordering::Relaxed));
        out.bytes(PREFIX);
        out.bytes(b"in flight: ");
        out.decimal(calls);
        out.bytes(if calls == 1 {
            b" native call, "
        } else {
            b" native calls, "
        });
        out.decimal(threads);
        out.bytes(if threads == 1 {
            b" thread"
        } else {
            b" threads"
        });
        out.line_end();
    }

    out.bytes(PREFIX);
    out.bytes(b"last binding events, oldest first:");
    out.line_end();
    let last = LAST_SEQ.load(Ordering::Acquire);
    let first = last.saturating_sub(RING_LEN as u64 - 1).max(1);
    let mut printed = false;
    for seq in first..=last {
        if let Some(entry) = read_entry(seq) {
            write_entry(&mut out, &entry);
            printed = true;
        }
    }
    if !printed {
        out.bytes(PREFIX);
        out.bytes(b"  (none)");
        out.line_end();
    }

    out.bytes(PREFIX);
    out.bytes(b"native backtrace:");
    out.line_end();
    out.flush();

    let mut frames = [ptr::null_mut::<c_void>(); 64];
    // SAFETY: `frames` has room for the entries requested. backtrace was warmed up at install,
    // so on glibc it no longer loads libgcc_s here.
    let count = unsafe { libc::backtrace(frames.as_mut_ptr(), frames.len() as c_int) };
    if count > 0 {
        // SAFETY: the first `count` entries were filled by backtrace; backtrace_symbols_fd writes
        // to the fd without calling malloc (glibc backtrace(3)).
        unsafe { libc::backtrace_symbols_fd(frames.as_ptr(), count, STDERR) };
    }
}

fn write_entry(out: &mut Output, entry: &Snapshot) {
    out.bytes(PREFIX);
    out.bytes(b"  #");
    out.decimal(entry.seq);
    out.bytes(b" +");
    out.decimal(entry.time_ns / 1_000_000_000);
    out.byte(b'.');
    let millis = (entry.time_ns / 1_000_000) % 1000;
    out.byte(b'0' + (millis / 100) as u8);
    out.byte(b'0' + (millis / 10 % 10) as u8);
    out.byte(b'0' + (millis % 10) as u8);
    out.bytes(b"s ");
    out.bytes(op_name(entry.op).as_bytes());
    if op_name(entry.op) == "unknown_op" {
        out.decimal(u64::from(entry.op));
    }
    out.byte(b' ');
    out.bytes(state_name(entry.state).as_bytes());
    out.bytes(b" conn=");
    out.decimal(entry.connection_id);
    out.bytes(b" handle=");
    out.hex(entry.handle);
    out.bytes(b" thread=");
    out.hex(entry.thread_id);
    if entry.text_len > 0 {
        out.bytes(b" text=\"");
        for &byte in entry.text.iter().take(entry.text_len) {
            // Keep the report one line per entry and plain ASCII.
            out.byte(if byte.is_ascii_graphic() || byte == b' ' {
                byte
            } else {
                b'?'
            });
        }
        out.byte(b'"');
    }
    out.line_end();
}

/// A stack buffer that writes to fd 2 with `write` only: no allocation, no locks, no panics.
struct Output {
    buffer: [u8; 512],
    len: usize,
}

impl Output {
    fn new() -> Self {
        Self {
            buffer: [0u8; 512],
            len: 0,
        }
    }

    fn byte(&mut self, byte: u8) {
        if self.len >= self.buffer.len() {
            self.flush();
        }
        if let Some(slot) = self.buffer.get_mut(self.len) {
            *slot = byte;
            self.len += 1;
        }
    }

    fn bytes(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.byte(byte);
        }
    }

    fn decimal(&mut self, mut value: u64) {
        let mut digits = [0u8; 20];
        let mut start = digits.len();
        loop {
            start -= 1;
            digits[start] = b'0' + (value % 10) as u8;
            value /= 10;
            if value == 0 {
                break;
            }
        }
        self.bytes(&digits[start..]);
    }

    fn hex(&mut self, value: u64) {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        self.bytes(b"0x");
        let mut started = false;
        for shift in (0..16).rev() {
            let nibble = ((value >> (shift * 4)) & 0xf) as usize;
            if nibble != 0 || started || shift == 0 {
                started = true;
                self.byte(DIGITS[nibble]);
            }
        }
    }

    fn line_end(&mut self) {
        self.byte(b'\n');
        self.flush();
    }

    fn flush(&mut self) {
        let mut written = 0;
        let mut failures = 0;
        while written < self.len && failures < 8 {
            let rest = &self.buffer[written..self.len];
            // SAFETY: `rest` is valid for reads of `rest.len()` bytes; write is async-signal-safe.
            let result = unsafe { libc::write(STDERR, rest.as_ptr().cast(), rest.len()) };
            if result > 0 {
                written += result as usize;
            } else {
                failures += 1; // EINTR or a full pipe; retry a few times, then drop the rest.
            }
        }
        self.len = 0;
    }
}

// ---------------------------------------------------------------------------------------------
// C exports
// ---------------------------------------------------------------------------------------------

/// Appends one ring entry; see `record`. `text` may be null when `text_len` is 0.
///
/// # Safety
/// When `text_len` is nonzero, `text` must be valid for reads of `text_len` bytes for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_ring_record(
    op: u32,
    state: u32,
    handle: u64,
    connection_id: u64,
    text: *const u8,
    text_len: usize,
) {
    let text = if text.is_null() || text_len == 0 {
        &[][..]
    } else {
        // SAFETY: the caller guarantees `text` is valid for `text_len` bytes; record copies at
        // most 120 of them before it returns.
        unsafe { std::slice::from_raw_parts(text, text_len) }
    };
    record(op, state, handle, connection_id, text);
}

/// Installs the crash handler; see `install_crash_handler`. Returns 0 or a nonzero error code.
///
/// # Safety
/// When `header_len` is nonzero, `header` must be valid for reads of `header_len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_install_crash_handler(header: *const u8, header_len: usize) -> i32 {
    let header = if header.is_null() || header_len == 0 {
        &[][..]
    } else {
        // SAFETY: the caller guarantees `header` is valid for `header_len` bytes; it is copied.
        unsafe { std::slice::from_raw_parts(header, header_len) }
    };
    install_crash_handler(header)
}

/// Crashes the process on purpose, for tests: 1 dereferences null, 2 aborts, 3 overflows the
/// stack of a new native thread set up with `on_native_thread_start`. Other values do nothing.
#[unsafe(no_mangle)]
pub extern "C" fn dbs_crash_for_test(kind: u32) {
    match kind {
        1 => {
            let null = std::hint::black_box(ptr::null::<u8>());
            // SAFETY: none; this read faults on purpose, which is the point of the test hook.
            let value = unsafe { ptr::read_volatile(null) };
            std::hint::black_box(value);
        }
        2 => std::process::abort(),
        3 => {
            let spawned = std::thread::Builder::new()
                .name("duckdb-bun:crash-test".to_owned())
                .stack_size(256 * 1024)
                .spawn(|| {
                    on_native_thread_start();
                    overflow_stack(0)
                });
            if let Ok(thread) = spawned {
                thread.join().ok();
            }
        }
        _ => {}
    }
}

#[inline(never)]
fn overflow_stack(depth: u64) -> u64 {
    let mut frame = [0u8; 1024];
    frame[0] = depth as u8;
    std::hint::black_box(&mut frame);
    if depth == u64::MAX {
        return 0;
    }
    overflow_stack(depth + 1).wrapping_add(u64::from(frame[1]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The ring is process-global; tests that read back their own entries hold this lock so a
    /// concurrently running ring test cannot overwrite them first.
    static RING_TESTS: Mutex<()> = Mutex::new(());

    #[test]
    fn concurrent_writers_never_yield_a_torn_read() {
        let _ring = RING_TESTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let writers: Vec<_> = (0..4u64)
            .map(|writer| {
                std::thread::spawn(move || {
                    for index in 0..20_000u64 {
                        let value = (writer << 32) | index;
                        let text = value.to_ne_bytes().repeat(15);
                        record(4, 4, value, value, &text);
                    }
                })
            })
            .collect();
        let mut checked = 0u64;
        while writers.iter().any(|writer| !writer.is_finished()) {
            let last = LAST_SEQ.load(Ordering::Acquire);
            for seq in last.saturating_sub(RING_LEN as u64 - 1).max(1)..=last {
                if let Some(entry) = read_entry(seq) {
                    if entry.op != 4 {
                        continue; // written by another test
                    }
                    assert_eq!(entry.handle, entry.connection_id);
                    assert_eq!(entry.text_len, TEXT_MAX);
                    for chunk in entry.text.chunks(8) {
                        assert_eq!(chunk, entry.handle.to_ne_bytes());
                    }
                    checked += 1;
                }
            }
        }
        for writer in writers {
            writer.join().expect("writer thread");
        }
        assert!(checked > 0);
    }

    #[test]
    fn text_is_truncated_to_120_bytes() {
        let _ring = RING_TESTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let text = [b'x'; 300];
        record(32, 4, 1, 2, &text);
        let last = LAST_SEQ.load(Ordering::Acquire);
        let found = (last.saturating_sub(RING_LEN as u64 - 1).max(1)..=last)
            .rev()
            .filter_map(read_entry)
            .find(|entry| entry.op == 32 && entry.handle == 1 && entry.connection_id == 2)
            .expect("entry");
        assert_eq!(entry_text(&found), &text[..TEXT_MAX]);
    }

    fn current_alt_stack() -> libc::stack_t {
        let mut current = MaybeUninit::<libc::stack_t>::zeroed();
        // SAFETY: a null new stack only queries; `current` is a valid out pointer.
        assert_eq!(
            unsafe { libc::sigaltstack(ptr::null(), current.as_mut_ptr()) },
            0
        );
        // SAFETY: sigaltstack succeeded and filled `current`.
        unsafe { current.assume_init() }
    }

    /// The op and state names a crash report prints are the ones native/ABI.md documents: the
    /// job ops in the jobs table's order from 1, the JavaScript-recorded ops, and the states.
    #[test]
    fn op_and_state_names_match_the_abi() {
        let abi = include_str!("../ABI.md");
        let jobs = abi
            .split("| Export | Inputs | Outputs |")
            .nth(1)
            .expect("ABI.md has the jobs table");
        let job_ops: Vec<&str> = jobs
            .lines()
            .skip(2)
            .take_while(|line| line.starts_with("| `dbs_job_"))
            .map(|line| line["| `dbs_job_".len()..].split('`').next().unwrap())
            .collect();
        assert_eq!(job_ops.len(), 11, "{job_ops:?}");
        for (index, name) in job_ops.iter().enumerate() {
            assert_eq!(op_name(index as u32 + 1), *name);
        }

        let codes = abi
            .lines()
            .find(|line| line.starts_with("Op codes are"))
            .and_then(|line| line.split("then ").nth(1))
            .expect("ABI.md lists the op codes");
        let mut listed = 0;
        for pair in codes.trim_end_matches('.').split(", ") {
            let (code, words) = pair.split_once(' ').unwrap();
            assert_eq!(op_name(code.parse().unwrap()), words.replace(' ', "_"));
            listed += 1;
        }
        assert_eq!(listed, 11);

        let states = abi
            .split("state (")
            .nth(1)
            .and_then(|rest| rest.split(')').next())
            .expect("ABI.md lists the states");
        for pair in states.split(", ") {
            let (code, name) = pair.split_once(' ').unwrap();
            assert_eq!(state_name(code.parse().unwrap()), name);
        }

        for unknown in [0, 12, 31, 43, u32::MAX] {
            assert_eq!(op_name(unknown), "unknown_op");
        }
        assert_eq!(state_name(0), "unknown_state");
        assert_eq!(state_name(5), "unknown_state");
    }

    #[test]
    fn native_thread_start_installs_our_alternate_stack_and_names_the_thread() {
        let installed = std::thread::Builder::new()
            .name("duckdb-bun:unit".to_owned())
            .spawn(|| {
                on_native_thread_start();
                on_native_thread_start();
                let stack = current_alt_stack();
                let mut name = [0u8; NAME_MAX];
                let len = lookup_thread_name(os_thread_id(), &mut name);
                (
                    stack.ss_flags & libc::SS_DISABLE,
                    stack.ss_size,
                    name[..len].to_vec(),
                )
            })
            .expect("spawn")
            .join()
            .expect("join");
        let size = alt_stack_size(page_size());
        assert!(size >= libc::SIGSTKSZ.max(64 * 1024));
        assert_eq!(installed, (0, size, b"duckdb-bun:unit".to_vec()));
    }

    #[test]
    fn set_thread_name_renames_the_calling_thread_only() {
        let names = std::thread::Builder::new()
            .name("duckdb-bun:pool".to_owned())
            .spawn(|| {
                on_native_thread_start();
                let read = || {
                    let mut name = [0u8; NAME_MAX];
                    let len = lookup_thread_name(os_thread_id(), &mut name);
                    name[..len].to_vec()
                };
                set_thread_name(b"duckdb-bun:execute_prepared");
                let long = read();
                set_thread_name(b"duckdb-bun:query");
                let short = read();
                set_thread_name(&[b'x'; NAME_MAX + 10]);
                (long, short, read())
            })
            .expect("spawn")
            .join()
            .expect("join");
        assert_eq!(
            names,
            (
                b"duckdb-bun:execute_prepared".to_vec(),
                b"duckdb-bun:query".to_vec(),
                vec![b'x'; NAME_MAX],
            )
        );
    }

    fn entry_text(entry: &Snapshot) -> &[u8] {
        &entry.text[..entry.text_len]
    }
}
