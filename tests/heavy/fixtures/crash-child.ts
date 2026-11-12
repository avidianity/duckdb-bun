// Child process for crash-report.test.ts: loads the bindings (which install the
// crash handler), runs one traced query, then crashes on purpose through the
// shim's test hook. Usage: bun crash-child.ts <kind>, with kind from native/ABI.md.
import * as db from "../../../src/bindings/api/database.ts";
import * as q from "../../../src/bindings/api/query.ts";
import { shim } from "../../../src/bindings/runtime/native.ts";

const kind = Number(process.argv[2]);
const database = await db.open();
const connection = await db.connect(database);
await q.query(connection, "SELECT 'plain-text' AS plain");
await q.query(connection, "SET s3_secret_access_key = 'do-not-print-me'").catch(() => undefined);
shim.dbs_crash_for_test(kind);
process.stdout.write("the crash hook returned\n");
