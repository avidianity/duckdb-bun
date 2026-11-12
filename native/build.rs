//! Link settings for the shim.
//!
//! - The cdylib gets an rpath of the directory it is loaded from, so it finds the
//!   libduckdb shipped beside it in the platform package (`@rpath/libduckdb.dylib`
//!   is libduckdb's install name on macOS).
//! - libduckdb is looked up in `DUCKDB_LIB_DIR`, or, when that is unset, in the
//!   host's `packages/duckdb-bun-<platform>/`, so a plain `cargo test` works after
//!   `bun run fetch-lib`.
//! - Test binaries get an absolute rpath to that directory, so they run without
//!   `DYLD_LIBRARY_PATH` or `LD_LIBRARY_PATH`.
//! - `cfg(coverage)` is declared, so the coverage-only code in src/diag.rs passes the
//!   `unexpected_cfgs` lint.

use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-env-changed=DUCKDB_LIB_DIR");
    // `cargo llvm-cov` builds with `--cfg coverage`; src/diag.rs uses it to write the coverage
    // profile of a crashing process (`bun run coverage`).
    println!("cargo::rustc-check-cfg=cfg(coverage)");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();

    // The install name and soname keep the build directory out of the shipped file.
    match target_os.as_str() {
        "macos" => {
            println!("cargo::rustc-link-arg-cdylib=-Wl,-rpath,@loader_path");
            println!(
                "cargo::rustc-link-arg-cdylib=-Wl,-install_name,@rpath/libduckdb_bun_shim.dylib"
            );
        }
        "linux" => {
            println!("cargo::rustc-link-arg-cdylib=-Wl,-rpath,$ORIGIN");
            println!("cargo::rustc-link-arg-cdylib=-Wl,-soname,libduckdb_bun_shim.so");
        }
        _ => {}
    }

    let lib_dir = match env::var_os("DUCKDB_LIB_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => {
            let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap_or_default());
            let platform = match (target_os.as_str(), target_arch.as_str()) {
                ("macos", "aarch64") => "darwin-arm64",
                ("linux", "x86_64") => "linux-x64",
                ("linux", "aarch64") => "linux-arm64",
                _ => return,
            };
            manifest_dir
                .join("..")
                .join("packages")
                .join(format!("duckdb-bun-{platform}"))
        }
    };
    let lib_dir = lib_dir.canonicalize().unwrap_or(lib_dir);

    // libduckdb-sys emits the same search path when DUCKDB_LIB_DIR is set; this
    // covers the default directory, where it emits only the link-lib directive.
    println!("cargo::rustc-link-search=native={}", lib_dir.display());
    if matches!(target_os.as_str(), "macos" | "linux") {
        println!(
            "cargo::rustc-link-arg-tests=-Wl,-rpath,{}",
            lib_dir.display()
        );
    }
}
