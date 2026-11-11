// Runs the vendored official @duckdb/node-api test suite (duckdb-node-neo v2.0.0-r.1,
// vendor/node-api/test) under bun:test. Importing each file registers its tests
// through the vitest shim that tests/preload.ts swaps in.
import "../../vendor/node-api/test/appender.test.ts";
import "../../vendor/node-api/test/close.test.ts";
import "../../vendor/node-api/test/config.test.ts";
import "../../vendor/node-api/test/connection.test.ts";
import "../../vendor/node-api/test/data-chunk-columns.test.ts";
import "../../vendor/node-api/test/data-chunk-converted.test.ts";
import "../../vendor/node-api/test/data-chunk-creation.test.ts";
import "../../vendor/node-api/test/data-chunk-writer.test.ts";
import "../../vendor/node-api/test/enum-type.test.ts";
import "../../vendor/node-api/test/enums.test.ts";
import "../../vendor/node-api/test/extensions.test.ts";
import "../../vendor/node-api/test/index-bounds.test.ts";
import "../../vendor/node-api/test/instance-cache.test.ts";
import "../../vendor/node-api/test/integer-ranges.test.ts";
import "../../vendor/node-api/test/js-writes.test.ts";
import "../../vendor/node-api/test/metadata.test.ts";
import "../../vendor/node-api/test/prepared.test.ts";
import "../../vendor/node-api/test/read-value.test.ts";
import "../../vendor/node-api/test/readme-write-examples.test.ts";
import "../../vendor/node-api/test/results.test.ts";
import "../../vendor/node-api/test/scalar-functions.test.ts";
import "../../vendor/node-api/test/sql-utils.test.ts";
import "../../vendor/node-api/test/table-functions.test.ts";
import "../../vendor/node-api/test/table-names.test.ts";
import "../../vendor/node-api/test/time-ns.test.ts";
import "../../vendor/node-api/test/tuples.test.ts";
import "../../vendor/node-api/test/type-mappings.test.ts";
import "../../vendor/node-api/test/types.test.ts";
import "../../vendor/node-api/test/uuid.test.ts";
import "../../vendor/node-api/test/variant.test.ts";
import "../../vendor/node-api/test/varint.test.ts";
