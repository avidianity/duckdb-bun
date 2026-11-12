// Secret parity: CREATE SECRET, CREATE PERSISTENT SECRET, duckdb_secrets() rows with
// their redaction, DROP SECRET, and the errors around them.
//
// The s3 secret type lives in the httpfs extension, so the s3 scenarios install it
// (into a temporary extension directory) and skip when DUCKDB_BUN_OFFLINE=1. The
// http secret type is built in, so those scenarios need no network.
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { capture, OFFLINE, parityFor, withConnection } from "./harness.ts";

const parity = parityFor(import.meta.path);

/** Instance options that keep extensions and persistent secrets out of the user's ~/.duckdb. */
function isolatedOptions(tmp: string, shared: string): Record<string, string> {
  return {
    extension_directory: join(shared, "extensions"),
    secret_directory: join(tmp, "secrets"),
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
  };
}

async function secrets(connection: DuckDBConnection) {
  return (await connection.runAndReadAll("SELECT * FROM duckdb_secrets() ORDER BY name")).getRowObjectsJson();
}

parity(
  "built-in http secret: create, list, duplicate, replace, drop",
  (api, { tmp, shared }) =>
    withConnection(
      api,
      async (connection) => {
        await connection.run("CREATE SECRET web (TYPE http, BEARER_TOKEN 'tok-123')");
        await connection.run(
          "CREATE SECRET web_scoped (TYPE http, BEARER_TOKEN 'tok-456', SCOPE 'https://example.com/api')",
        );
        const created = await secrets(connection);
        const duplicate = await capture(() => connection.run("CREATE SECRET web (TYPE http, BEARER_TOKEN 'other')"));
        const ifNotExists = await capture(() =>
          connection.run("CREATE SECRET IF NOT EXISTS web (TYPE http, BEARER_TOKEN 'other')"),
        );
        await connection.run("CREATE OR REPLACE SECRET web (TYPE http, BEARER_TOKEN 'replaced')");
        const replaced = await secrets(connection);
        const which = (
          await connection.runAndReadAll("SELECT * FROM which_secret('https://example.com/api/x', 'http')")
        ).getRowObjectsJson();
        await connection.run("DROP SECRET web");
        const dropMissing = await capture(() => connection.run("DROP SECRET web"));
        const dropIfExists = await capture(() => connection.run("DROP SECRET IF EXISTS web"));
        return {
          created,
          duplicate,
          ifNotExists,
          replaced,
          which,
          dropMissing,
          dropIfExists,
          after: await secrets(connection),
        };
      },
      ":memory:",
      isolatedOptions(tmp, shared),
    ),
  { official: "ok" },
);

parity(
  "built-in http secret: persistent in a file database, seen after reopening",
  async (api, { tmp, shared }) => {
    const path = join(tmp, "secrets.duckdb");
    const options = isolatedOptions(tmp, shared);
    const first = await withConnection(
      api,
      async (connection) => {
        await connection.run("CREATE PERSISTENT SECRET kept (TYPE http, BEARER_TOKEN 'persist-me')");
        await connection.run("CREATE TEMPORARY SECRET temp (TYPE http, BEARER_TOKEN 'forget-me')");
        return {
          rows: await secrets(connection),
          duplicate: await capture(() => connection.run("CREATE PERSISTENT SECRET kept (TYPE http, BEARER_TOKEN 'x')")),
        };
      },
      path,
      options,
    );
    const reopened = await withConnection(
      api,
      async (connection) => {
        const rows = await secrets(connection);
        await connection.run("DROP PERSISTENT SECRET kept");
        return { rows, afterDrop: await secrets(connection) };
      },
      path,
      options,
    );
    return { first, reopened };
  },
  { official: "ok" },
);

parity(
  "s3 secret without httpfs loaded",
  (api, { tmp, shared }) =>
    withConnection(
      api,
      (connection) =>
        connection.run("CREATE SECRET s (TYPE s3, KEY_ID 'AKIAEXAMPLE', SECRET 'shh', REGION 'us-east-1')"),
      ":memory:",
      isolatedOptions(tmp, shared),
    ),
  { official: "error" },
);

/** Installs and loads httpfs from the network into the scenario's extension directory. */
async function loadHttpfs(connection: DuckDBConnection) {
  await connection.run("INSTALL httpfs");
  await connection.run("LOAD httpfs");
}

parity(
  "s3 secret: create, list redacted, duplicate, drop",
  (api, { tmp, shared }) =>
    withConnection(
      api,
      async (connection) => {
        await loadHttpfs(connection);
        await connection.run(
          "CREATE SECRET s3_main (TYPE s3, KEY_ID 'AKIAEXAMPLE', SECRET 'super-secret-value', REGION 'us-east-1')",
        );
        await connection.run(
          "CREATE SECRET s3_scoped (TYPE s3, KEY_ID 'AKIASCOPED', SECRET 'another-secret', REGION 'eu-west-1', SCOPE 's3://bucket/prefix')",
        );
        const created = await secrets(connection);
        const duplicate = await capture(() =>
          connection.run("CREATE SECRET s3_main (TYPE s3, KEY_ID 'AKIAOTHER', SECRET 'x', REGION 'us-west-2')"),
        );
        const which = (
          await connection.runAndReadAll(
            "SELECT name, persistent, storage FROM which_secret('s3://bucket/prefix/file.parquet', 's3')",
          )
        ).getRowObjectsJson();
        await connection.run("DROP SECRET s3_main");
        const dropMissing = await capture(() => connection.run("DROP SECRET s3_main"));
        return { created, duplicate, which, dropMissing, after: await secrets(connection) };
      },
      ":memory:",
      isolatedOptions(tmp, shared),
    ),
  { official: "ok", skip: OFFLINE, timeout: 120_000 },
);

parity(
  "s3 secret: persistent in a file database, seen after reopening",
  async (api, { tmp, shared }) => {
    const path = join(tmp, "s3.duckdb");
    const options = isolatedOptions(tmp, shared);
    const first = await withConnection(
      api,
      async (connection) => {
        await loadHttpfs(connection);
        await connection.run(
          "CREATE PERSISTENT SECRET s3_kept (TYPE s3, KEY_ID 'AKIAEXAMPLE', SECRET 'persisted-secret', REGION 'us-east-1')",
        );
        return secrets(connection);
      },
      path,
      options,
    );
    const reopened = await withConnection(
      api,
      async (connection) => {
        await connection.run("LOAD httpfs");
        const rows = await secrets(connection);
        await connection.run("DROP PERSISTENT SECRET s3_kept");
        return { rows, afterDrop: await secrets(connection) };
      },
      path,
      options,
    );
    return { first, reopened };
  },
  { official: "ok", skip: OFFLINE, timeout: 120_000 },
);
