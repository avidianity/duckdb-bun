// The C++ exception boundary between libduckdb and bun:ffi (docs/adr/0003, native/ABI.md).
//
// Many libduckdb C API functions let a C++ exception escape on bad input, such as
// duckdb_to_date() with month 0. Through bun:ffi that aborts the process, and Rust
// cannot catch a C++ exception, so every C API function JavaScript calls goes through
// a generated wrapper in capi.cpp that catches it, records its message for the
// calling thread, and returns a zero value. The binding checks the flag after the
// call and throws the message as a JavaScript Error.
#pragma once

#include <cstddef>
#include <cstdint>
#include <tuple>

#include "duckdb.h"

namespace dbs {

/// Records the exception being handled for the calling thread. Call only inside a catch block.
void record_exception() noexcept;

/// The parameter and return types of a C function type, so the generated wrappers
/// take exactly what the C API declares.
template <typename F>
struct signature;

template <typename R, typename... A>
struct signature<R(A...)> {
  using ret = R;
  template <std::size_t I>
  using arg = std::tuple_element_t<I, std::tuple<A...>>;
};

}  // namespace dbs

#define DBS_RET(fn) ::dbs::signature<decltype(fn)>::ret
#define DBS_ARG(fn, i) ::dbs::signature<decltype(fn)>::template arg<i>
