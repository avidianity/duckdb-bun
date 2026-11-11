//! Scalar and table function callbacks.
//!
//! The shim registers its own trampolines with DuckDB and forwards each call to
//! JavaScript as a [`Call`]. On the JS thread it calls the sync dispatcher
//! directly; on any other thread it posts `on_call` and blocks until JavaScript
//! calls `dbs_call_done`. Mirrors `duckdb_thread_callback.h` and the
//! `*_function_helpers.h` files of the official binding.
//!
//! JavaScript objects (extra info, bind data, init data, state) cross as ids.
//! Each id is held by a [`DataId`] whose drop posts `on_release(id)`, so the
//! release fires exactly once per id, on whatever thread DuckDB destroys it.

use std::ffi::{CStr, c_void};
use std::ptr::{self, null_mut};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;

use libduckdb_sys as ffi;

use crate::counters;
use crate::runtime;

/// Scalar function bind.
pub const KIND_SCALAR_BIND: u32 = 1;
/// Scalar function init.
pub const KIND_SCALAR_INIT: u32 = 2;
/// Scalar function main.
pub const KIND_SCALAR_MAIN: u32 = 3;
/// Table function bind.
pub const KIND_TABLE_BIND: u32 = 4;
/// Table function init.
pub const KIND_TABLE_INIT: u32 = 5;
/// Table function local init.
pub const KIND_TABLE_LOCAL_INIT: u32 = 6;
/// Table function main.
pub const KIND_TABLE_MAIN: u32 = 7;

const NOT_INITIALIZED: &CStr = c"duckdb-bun: a function callback ran before dbs_init";
const NO_SYNC_DISPATCHER: &CStr =
    c"duckdb-bun: a function callback ran on the JS thread before dbs_set_sync_call";
const NO_FUNCTION_ID: &CStr = c"duckdb-bun: the function has no callback id";

/// One function callback in flight, read by JavaScript (layout in `native/ABI.md`).
#[repr(C)]
pub struct Call {
    /// One of the `KIND_*` constants.
    pub kind: u32,
    /// The id JavaScript passed when it set the callback.
    pub function_id: u64,
    /// Bind, init or function info.
    pub info: *mut c_void,
    /// Scalar main: input data chunk. Table main: output data chunk.
    pub input: *mut c_void,
    /// Scalar main: output vector.
    pub output: *mut c_void,
    signal: Arc<Signal>,
}

const _: () = {
    assert!(std::mem::offset_of!(Call, kind) == 0);
    assert!(std::mem::offset_of!(Call, function_id) == 8);
    assert!(std::mem::offset_of!(Call, info) == 16);
    assert!(std::mem::offset_of!(Call, input) == 24);
    assert!(std::mem::offset_of!(Call, output) == 32);
};

#[derive(Default)]
struct Signal {
    done: Mutex<bool>,
    cv: Condvar,
}

/// A JavaScript object id owned by DuckDB. Dropping it posts `on_release(id)`.
pub struct DataId(pub u64);

impl Drop for DataId {
    fn drop(&mut self) {
        if self.0 == 0 {
            return;
        }
        if let Some(runtime) = runtime::get() {
            (runtime.on_release)(self.0);
        }
    }
}

fn new_plain(id: u64) -> *mut c_void {
    Box::into_raw(Box::new(DataId(id))).cast()
}

fn new_shared(id: u64) -> *mut c_void {
    Box::into_raw(Box::new(Arc::new(DataId(id)))).cast()
}

/// Destroy callback for a plain `Box<DataId>`.
///
/// # Safety
///
/// `data` is null or a pointer the shim created for a plain id and has not freed.
pub unsafe extern "C" fn destroy_plain(data: *mut c_void) {
    if !data.is_null() {
        // SAFETY: the caller passes a live `Box<DataId>` that DuckDB now gives up.
        drop(unsafe { Box::from_raw(data.cast::<DataId>()) });
    }
}

/// Destroy callback for a shared `Box<Arc<DataId>>` (scalar function bind data).
///
/// # Safety
///
/// `data` is null or a pointer the shim created for a shared id and has not freed.
pub unsafe extern "C" fn destroy_shared(data: *mut c_void) {
    if !data.is_null() {
        // SAFETY: the caller passes a live `Box<Arc<DataId>>` that DuckDB now gives up.
        drop(unsafe { Box::from_raw(data.cast::<Arc<DataId>>()) });
    }
}

/// Copy callback for a shared `Box<Arc<DataId>>`: a new box sharing the same id.
///
/// # Safety
///
/// `data` is null or a live pointer the shim created for a shared id.
pub unsafe extern "C" fn copy_shared(data: *mut c_void) -> *mut c_void {
    if data.is_null() {
        return null_mut();
    }
    // SAFETY: the caller passes a live `Box<Arc<DataId>>`; only the Arc is cloned.
    let shared = unsafe { Arc::clone(&*data.cast::<Arc<DataId>>()) };
    Box::into_raw(Box::new(shared)).cast()
}

/// Reads the id behind a plain pointer, 0 for null.
///
/// # Safety
///
/// `data` is null or a live pointer the shim created for a plain id.
pub unsafe fn read_plain(data: *mut c_void) -> u64 {
    if data.is_null() {
        return 0;
    }
    // SAFETY: the caller passes a live `Box<DataId>`.
    unsafe { (*data.cast::<DataId>()).0 }
}

/// Reads the id behind a shared pointer, 0 for null.
///
/// # Safety
///
/// `data` is null or a live pointer the shim created for a shared id.
pub unsafe fn read_shared(data: *mut c_void) -> u64 {
    if data.is_null() {
        return 0;
    }
    // SAFETY: the caller passes a live `Box<Arc<DataId>>`.
    unsafe { (&*data.cast::<Arc<DataId>>()).0 }
}

/// Reports `message` as the error of the callback `kind` on `info`.
fn set_error(kind: u32, info: *mut c_void, message: &CStr) {
    let message = message.as_ptr();
    // SAFETY: `info` is the info DuckDB passed to the trampoline for `kind`, and
    // each arm uses the set-error function of that info's family.
    unsafe {
        match kind {
            KIND_SCALAR_BIND => ffi::duckdb_scalar_function_bind_set_error(info.cast(), message),
            KIND_SCALAR_INIT => ffi::duckdb_scalar_function_init_set_error(info.cast(), message),
            KIND_SCALAR_MAIN => ffi::duckdb_scalar_function_set_error(info.cast(), message),
            KIND_TABLE_BIND => ffi::duckdb_bind_set_error(info.cast(), message),
            KIND_TABLE_INIT | KIND_TABLE_LOCAL_INIT => {
                ffi::duckdb_init_set_error(info.cast(), message)
            }
            KIND_TABLE_MAIN => ffi::duckdb_function_set_error(info.cast(), message),
            _ => {}
        }
    }
}

/// Runs one function callback in JavaScript and returns once it has run.
fn dispatch(
    kind: u32,
    function_id: u64,
    info: *mut c_void,
    input: *mut c_void,
    output: *mut c_void,
) {
    let Some(runtime) = runtime::get() else {
        set_error(kind, info, NOT_INITIALIZED);
        return;
    };
    if function_id == 0 {
        set_error(kind, info, NO_FUNCTION_ID);
        return;
    }
    let mut call = Call {
        kind,
        function_id,
        info,
        input,
        output,
        signal: Arc::default(),
    };
    let call_ptr = ptr::from_mut(&mut call);

    if thread::current().id() == runtime.js_thread {
        match runtime::sync_call() {
            Some(on_call_sync) => {
                counters::add(counters::CALLS_INLINE, 1);
                on_call_sync(call_ptr);
            }
            None => set_error(kind, info, NO_SYNC_DISPATCHER),
        }
        return;
    }

    let signal = Arc::clone(&call.signal);
    counters::add(counters::CALLS_POSTED, 1);
    (runtime.on_call)(call_ptr);
    let mut done = signal.done.lock().unwrap_or_else(PoisonError::into_inner);
    while !*done {
        done = signal.cv.wait(done).unwrap_or_else(PoisonError::into_inner);
    }
    drop(done);
    counters::add(counters::CALLS_COMPLETED, 1);
}

/// Releases the DuckDB thread blocked on `call`.
///
/// # Safety
///
/// `call` is a pointer passed to `on_call` whose `dbs_call_done` has not run yet.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_call_done(call: *mut Call) {
    if call.is_null() {
        return;
    }
    // SAFETY: the waiting thread keeps `call` alive until `done` is set below.
    // Holding our own Arc keeps the mutex and condvar alive after it wakes and
    // frees the call.
    let signal = unsafe { Arc::clone(&(*call).signal) };
    let mut done = signal.done.lock().unwrap_or_else(PoisonError::into_inner);
    *done = true;
    // Notify while holding the lock, as duckdb_thread_callback.h does.
    signal.cv.notify_one();
    drop(done);
}

unsafe extern "C" fn scalar_bind(info: ffi::duckdb_bind_info) {
    // SAFETY: DuckDB passes a live bind info of a function whose extra info the
    // shim set.
    let id = unsafe { read_plain(ffi::duckdb_scalar_function_bind_get_extra_info(info)) };
    dispatch(KIND_SCALAR_BIND, id, info.cast(), null_mut(), null_mut());
}

unsafe extern "C" fn scalar_init(info: ffi::duckdb_init_info) {
    // SAFETY: as in `scalar_bind`, for an init info.
    let id = unsafe { read_plain(ffi::duckdb_scalar_function_init_get_extra_info(info)) };
    dispatch(KIND_SCALAR_INIT, id, info.cast(), null_mut(), null_mut());
}

unsafe extern "C" fn scalar_main(
    info: ffi::duckdb_function_info,
    input: ffi::duckdb_data_chunk,
    output: ffi::duckdb_vector,
) {
    // SAFETY: as in `scalar_bind`, for a function info.
    let id = unsafe { read_plain(ffi::duckdb_scalar_function_get_extra_info(info)) };
    dispatch(
        KIND_SCALAR_MAIN,
        id,
        info.cast(),
        input.cast(),
        output.cast(),
    );
}

unsafe extern "C" fn table_bind(info: ffi::duckdb_bind_info) {
    // SAFETY: as in `scalar_bind`, for a table function.
    let id = unsafe { read_plain(ffi::duckdb_bind_get_extra_info(info)) };
    dispatch(KIND_TABLE_BIND, id, info.cast(), null_mut(), null_mut());
}

unsafe extern "C" fn table_init(info: ffi::duckdb_init_info) {
    // SAFETY: as in `table_bind`, for an init info.
    let id = unsafe { read_plain(ffi::duckdb_init_get_extra_info(info)) };
    dispatch(KIND_TABLE_INIT, id, info.cast(), null_mut(), null_mut());
}

unsafe extern "C" fn table_local_init(info: ffi::duckdb_init_info) {
    // SAFETY: as in `table_bind`, for an init info.
    let id = unsafe { read_plain(ffi::duckdb_init_get_extra_info(info)) };
    dispatch(
        KIND_TABLE_LOCAL_INIT,
        id,
        info.cast(),
        null_mut(),
        null_mut(),
    );
}

unsafe extern "C" fn table_main(info: ffi::duckdb_function_info, output: ffi::duckdb_data_chunk) {
    // SAFETY: as in `table_bind`, for a function info.
    let id = unsafe { read_plain(ffi::duckdb_function_get_extra_info(info)) };
    dispatch(KIND_TABLE_MAIN, id, info.cast(), output.cast(), null_mut());
}

/// Sets the scalar function's main trampoline, and its bind and init
/// trampolines when asked, with extra info holding `function_id`.
///
/// Call once per function object, after JavaScript knows all its callbacks.
///
/// # Safety
///
/// `scalar_function` is a live `duckdb_scalar_function`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_scalar_function_set_callbacks(
    scalar_function: ffi::duckdb_scalar_function,
    function_id: u64,
    has_bind: bool,
    has_init: bool,
) {
    // SAFETY: the caller passes a live scalar function; DuckDB owns the extra
    // info from here and frees it with `destroy_plain`.
    unsafe {
        ffi::duckdb_scalar_function_set_extra_info(
            scalar_function,
            new_plain(function_id),
            Some(destroy_plain),
        );
        ffi::duckdb_scalar_function_set_function(scalar_function, Some(scalar_main));
        if has_bind {
            ffi::duckdb_scalar_function_set_bind(scalar_function, Some(scalar_bind));
        }
        if has_init {
            ffi::duckdb_scalar_function_set_init(scalar_function, Some(scalar_init));
        }
    }
}

/// The same for table functions; the main trampoline is always set.
///
/// # Safety
///
/// `table_function` is a live `duckdb_table_function`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_table_function_set_callbacks(
    table_function: ffi::duckdb_table_function,
    function_id: u64,
    has_bind: bool,
    has_init: bool,
    has_local_init: bool,
) {
    // SAFETY: as in `dbs_scalar_function_set_callbacks`.
    unsafe {
        ffi::duckdb_table_function_set_extra_info(
            table_function,
            new_plain(function_id),
            Some(destroy_plain),
        );
        ffi::duckdb_table_function_set_function(table_function, Some(table_main));
        if has_bind {
            ffi::duckdb_table_function_set_bind(table_function, Some(table_bind));
        }
        if has_init {
            ffi::duckdb_table_function_set_init(table_function, Some(table_init));
        }
        if has_local_init {
            ffi::duckdb_table_function_set_local_init(table_function, Some(table_local_init));
        }
    }
}

/// Sets bind data as an id. `kind` is the kind of the bind callback that
/// received `info`: `KIND_SCALAR_BIND` or `KIND_TABLE_BIND`; others are ignored.
///
/// Scalar bind data registers a copy callback; copies share one id, which is
/// released once, when the last copy is destroyed.
///
/// # Safety
///
/// `info` is the live bind info of a running bind callback of that kind.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_set_bind_data(info: ffi::duckdb_bind_info, kind: u32, data_id: u64) {
    match kind {
        // SAFETY: `info` is a live scalar bind info; DuckDB owns the box from here.
        KIND_SCALAR_BIND => unsafe {
            ffi::duckdb_scalar_function_set_bind_data(
                info,
                new_shared(data_id),
                Some(destroy_shared),
            );
            ffi::duckdb_scalar_function_set_bind_data_copy(info, Some(copy_shared));
        },
        // SAFETY: `info` is a live table bind info; DuckDB owns the box from here.
        KIND_TABLE_BIND => unsafe {
            ffi::duckdb_bind_set_bind_data(info, new_plain(data_id), Some(destroy_plain));
        },
        _ => {}
    }
}

/// Reads bind data as an id, 0 for none. `kind` is the kind of the callback that
/// received `info`: scalar init or main, table init, local init or main.
///
/// # Safety
///
/// `info` is the live info of a running callback of that kind.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_get_bind_data(info: *mut c_void, kind: u32) -> u64 {
    // SAFETY: `info` is a live info of `kind`, and the bind data behind it was
    // set by `dbs_set_bind_data` with the matching layout for its family.
    unsafe {
        match kind {
            KIND_SCALAR_INIT => {
                read_shared(ffi::duckdb_scalar_function_init_get_bind_data(info.cast()))
            }
            KIND_SCALAR_MAIN => read_shared(ffi::duckdb_scalar_function_get_bind_data(info.cast())),
            KIND_TABLE_INIT | KIND_TABLE_LOCAL_INIT => {
                read_plain(ffi::duckdb_init_get_bind_data(info.cast()))
            }
            KIND_TABLE_MAIN => read_plain(ffi::duckdb_function_get_bind_data(info.cast())),
            _ => 0,
        }
    }
}

/// Sets table function init data (global or local) as an id.
///
/// # Safety
///
/// `info` is the live init info of a running table init or local init callback.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_set_init_data(info: ffi::duckdb_init_info, data_id: u64) {
    // SAFETY: `info` is a live init info; DuckDB owns the box from here.
    unsafe { ffi::duckdb_init_set_init_data(info, new_plain(data_id), Some(destroy_plain)) }
}

/// Reads table function init data as an id, 0 for none.
///
/// # Safety
///
/// `info` is the live function info of a running table main callback.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_get_init_data(info: ffi::duckdb_function_info) -> u64 {
    // SAFETY: `info` is live, and the init data was set by `dbs_set_init_data`.
    unsafe { read_plain(ffi::duckdb_function_get_init_data(info)) }
}

/// Reads table function local init data as an id, 0 for none.
///
/// # Safety
///
/// `info` is the live function info of a running table main callback.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_get_local_init_data(info: ffi::duckdb_function_info) -> u64 {
    // SAFETY: `info` is live, and the local init data was set by `dbs_set_init_data`.
    unsafe { read_plain(ffi::duckdb_function_get_local_init_data(info)) }
}

/// Sets scalar function state as an id.
///
/// # Safety
///
/// `info` is the live init info of a running scalar init callback.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_scalar_init_set_state(info: ffi::duckdb_init_info, state_id: u64) {
    // SAFETY: `info` is a live scalar init info; DuckDB owns the box from here.
    unsafe {
        ffi::duckdb_scalar_function_init_set_state(info, new_plain(state_id), Some(destroy_plain))
    }
}

/// Reads scalar function state as an id, 0 for none.
///
/// # Safety
///
/// `info` is the live function info of a running scalar main callback.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dbs_scalar_get_state(info: ffi::duckdb_function_info) -> u64 {
    // SAFETY: `info` is live, and the state was set by `dbs_scalar_init_set_state`.
    unsafe { read_plain(ffi::duckdb_scalar_function_get_state(info)) }
}
