// Runs the vendored official @duckdb/node-bindings test suite (duckdb-node-neo
// v2.0.0-r.1, vendor/node-bindings/test) under bun:test. Importing each file
// registers its tests through the vitest shim that tests/preload.ts swaps in.
//
// stress/ is left out: it is a heavy suite, run one file at a time. It also needs
// a callable `gc` from `v8.setFlagsFromString('--expose-gc')`, and Bun's node:v8
// ignores that flag, so it fails with "ReferenceError: gc is not defined".
//
// A native crash (SIGSEGV, SIGBUS, SIGABRT) in any test kills the whole bun
// process, so this aggregate stops at the first one. To isolate a file, run it
// on its own; tests/preload.ts applies to it the same way:
//   bun test ./vendor/node-bindings/test/<name>.test.ts
import "../../vendor/node-bindings/test/appender.test.ts";
import "../../vendor/node-bindings/test/catalog_entry.test.ts";
import "../../vendor/node-bindings/test/catalog.test.ts";
import "../../vendor/node-bindings/test/client_context.test.ts";
import "../../vendor/node-bindings/test/config.test.ts";
import "../../vendor/node-bindings/test/connection.test.ts";
import "../../vendor/node-bindings/test/constants.test.ts";
import "../../vendor/node-bindings/test/conversion.test.ts";
import "../../vendor/node-bindings/test/create_vector.test.ts";
import "../../vendor/node-bindings/test/data_chunk.test.ts";
import "../../vendor/node-bindings/test/destroy_result.test.ts";
import "../../vendor/node-bindings/test/enums.test.ts";
import "../../vendor/node-bindings/test/errors.test.ts";
import "../../vendor/node-bindings/test/extracted_statements.test.ts";
import "../../vendor/node-bindings/test/fetch_error.test.ts";
import "../../vendor/node-bindings/test/index_bounds.test.ts";
import "../../vendor/node-bindings/test/instance_cache.test.ts";
import "../../vendor/node-bindings/test/logical_type.test.ts";
import "../../vendor/node-bindings/test/number_ranges.test.ts";
import "../../vendor/node-bindings/test/open.test.ts";
import "../../vendor/node-bindings/test/pending.test.ts";
import "../../vendor/node-bindings/test/prepared_statements.test.ts";
import "../../vendor/node-bindings/test/query.test.ts";
import "../../vendor/node-bindings/test/scalar_function_exit.test.ts";
import "../../vendor/node-bindings/test/scalar_functions.test.ts";
import "../../vendor/node-bindings/test/table_functions.test.ts";
import "../../vendor/node-bindings/test/table_names.test.ts";
import "../../vendor/node-bindings/test/validity_bounds.test.ts";
import "../../vendor/node-bindings/test/values.test.ts";
import "../../vendor/node-bindings/test/worker_threads.test.ts";
