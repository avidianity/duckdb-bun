//! Builds `native/src/diag.rs` on its own, so the crash handler can be tested in a child process
//! without the rest of the shim.

#[path = "../../src/diag.rs"]
pub mod diag;
