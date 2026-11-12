// The thread-local state of the C++ exception boundary (boundary.hpp).

#include "boundary.hpp"

#include <cstring>
#include <exception>

namespace {

/// Nonzero while the calling thread holds an exception the binding has not taken.
thread_local std::int32_t exception_flag = 0;
/// The exception's what(), copied with duckdb_malloc; null for one that is not a std::exception.
thread_local char *exception_message = nullptr;

char *copy(const char *text) noexcept {
  std::size_t length = std::strlen(text);
  auto *out = static_cast<char *>(duckdb_malloc(length + 1));
  if (out != nullptr) std::memcpy(out, text, length + 1);
  return out;
}

}  // namespace

namespace dbs {

void record_exception() noexcept {
  if (exception_message != nullptr) {
    duckdb_free(exception_message);
    exception_message = nullptr;
  }
  try {
    throw;
  } catch (const std::exception &error) {
    exception_message = copy(error.what());
  } catch (...) {
    // Not a std::exception: no message to report.
  }
  exception_flag = 1;
}

}  // namespace dbs

extern "C" {

/// The calling thread's exception flag; the binding reads it after every guarded call.
std::int32_t *dbs_cxx_exception_flag() noexcept { return &exception_flag; }

/// Takes the calling thread's exception message and clears the flag. The caller frees
/// the message with duckdb_free; it is null when the exception had none.
char *dbs_cxx_take_exception() noexcept {
  char *message = exception_message;
  exception_message = nullptr;
  exception_flag = 0;
  return message;
}

}  // extern "C"
