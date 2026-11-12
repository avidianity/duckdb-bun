// The message of a C++ exception the shim's boundary caught (native/cpp/boundary.hpp),
// built as DuckDB builds an error's message from one: ErrorData(const std::exception &)
// and ErrorData::ConstructFinalMessage() in src/common/error_data.cpp at the pinned tag.
//
// A DuckDB exception's what() is a JSON object whose exception_type is the type's
// display name, such as "Conversion", and whose exception_message is the text. Any
// other what() is the text of an exception of type INVALID.

/** ErrorData's text after an INTERNAL error's message; the stack trace it adds is left out. */
const INTERNAL_SUFFIX =
  "\nThis error signals an assertion failure within DuckDB. This usually occurs due to " +
  "unexpected conditions or errors in the program's logic.\nFor more information, see " +
  "https://duckdb.org/docs/current/dev/internal_errors";

/** The display names of DuckDB's ExceptionType values (EXCEPTION_MAP in src/common/exception.cpp). */
const EXCEPTION_TYPES = new Set([
  "Invalid",
  "Out of Range",
  "Conversion",
  "Unknown Type",
  "Decimal",
  "Mismatch Type",
  "Divide by Zero",
  "Object Size",
  "Invalid type",
  "Serialization",
  "TransactionContext",
  "Not implemented",
  "Expression",
  "Catalog",
  "Parser",
  "Binder",
  "Planner",
  "Scheduler",
  "Executor",
  "Constraint",
  "Index",
  "Stat",
  "Connection",
  "Syntax",
  "Settings",
  "Optimizer",
  "NullPointer",
  "IO",
  "INTERRUPT",
  "FATAL",
  "INTERNAL",
  "Invalid Input",
  "Out of Memory",
  "Permission",
  "Parameter Not Resolved",
  "Parameter Not Allowed",
  "Dependency",
  "Missing Extension",
  "HTTP",
  "Extension Autoloading",
  "Sequence",
  "Invalid Configuration",
  "Data Corruption",
  "Resource In Use",
]);

/** The what() of std::bad_alloc in libstdc++ and libc++. */
const BAD_ALLOC = "std::bad_alloc";

/**
 * The error message DuckDB reports for an exception whose what() is `what`, or a
 * generic one when the exception was not a std::exception (`what` null).
 */
export function exceptionMessage(what: string | null): string {
  if (what === null) return "Error: a C++ exception that is not a std::exception";
  let type = "Invalid";
  let message = what;
  if (what === BAD_ALLOC) {
    type = "Out of Memory";
    message = "Allocation failure";
  } else if (what.startsWith("{")) {
    const fields = parseFields(what);
    if (fields) {
      type = EXCEPTION_TYPES.has(fields.exception_type ?? "") ? (fields.exception_type as string) : "Invalid";
      message = fields.exception_message ?? "";
    }
  }
  message = message.replaceAll("\0", "\\0");
  // UNKNOWN_TYPE, whose display name is "Unknown Type", gets no prefix.
  const prefix = type === "Unknown Type" ? "" : `${type} `;
  return `${prefix}Error: ${message}${type === "INTERNAL" ? INTERNAL_SUFFIX : ""}`;
}

/** The string fields of a JSON object, or null when `text` is not one. */
function parseFields(text: string): Record<string, string | undefined> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw new Error("failed to parse a C++ exception message", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const fields: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") fields[key] = value;
  return fields;
}
