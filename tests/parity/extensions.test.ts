// Extension parity: INSTALL and LOAD for icu and azure, duckdb_extensions() rows, and
// icu-dependent queries. Installs go to a temporary extension directory, never the
// user's ~/.duckdb, and the scenarios that download skip when DUCKDB_BUN_OFFLINE=1.
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { OFFLINE, parityFor, withConnection } from "./harness.ts";

const parity = parityFor(import.meta.path);

const NETWORK = { official: "ok", skip: OFFLINE, timeout: 180_000 } as const;

function isolatedOptions(shared: string): Record<string, string> {
  return {
    extension_directory: join(shared, "extensions"),
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
  };
}

async function extensionRows(connection: DuckDBConnection) {
  return (
    await connection.runAndReadAll(
      "SELECT * FROM duckdb_extensions() WHERE extension_name IN ('icu', 'azure') ORDER BY extension_name",
    )
  ).getRowObjectsJson();
}

const ICU_QUERY = `
  SELECT
    TIMESTAMPTZ '2026-07-12 13:45:06+00' AT TIME ZONE 'America/New_York' AS ny_local,
    TIMESTAMP '2026-07-12 13:45:06' AT TIME ZONE 'Asia/Manila' AS manila_instant,
    strftime(TIMESTAMPTZ '2026-07-12 13:45:06+00' AT TIME ZONE 'Europe/Berlin', '%Y-%m-%d %H:%M:%S') AS berlin_text,
    strftime(TIMESTAMPTZ '2026-07-12 13:45:06+00', '%Y-%m-%d %H:%M:%S %Z') AS session_text,
    date_trunc('day', TIMESTAMPTZ '2026-07-12 23:30:00+00') AS truncated,
    timezone('Asia/Tokyo', TIMESTAMPTZ '2026-01-01 00:00:00+00') AS tokyo
`;

async function icuQuery(connection: DuckDBConnection) {
  await connection.run("SET TimeZone = 'Asia/Manila'");
  const reader = await connection.runAndReadAll(ICU_QUERY);
  return { types: reader.columnTypes().map(String), rows: reader.getRows(), json: reader.getRowObjectsJson() };
}

parity(
  "icu time zone query with the built-in icu",
  (api, { shared }) => withConnection(api, icuQuery, ":memory:", isolatedOptions(shared)),
  { official: "ok" },
);

parity(
  "INSTALL and LOAD icu, duckdb_extensions() rows, and an icu query",
  (api, { shared }) =>
    withConnection(
      api,
      async (connection) => {
        const before = await extensionRows(connection);
        await connection.run("INSTALL icu");
        await connection.run("LOAD icu");
        return { before, after: await extensionRows(connection), query: await icuQuery(connection) };
      },
      ":memory:",
      isolatedOptions(shared),
    ),
  NETWORK,
);

parity(
  "INSTALL and LOAD azure, and duckdb_extensions() rows",
  (api, { shared }) =>
    withConnection(
      api,
      async (connection) => {
        const before = await extensionRows(connection);
        await connection.run("INSTALL azure");
        const installed = await extensionRows(connection);
        await connection.run("LOAD azure");
        const loaded = await extensionRows(connection);
        await connection.run(
          "CREATE SECRET az (TYPE azure, CONNECTION_STRING 'DefaultEndpointsProtocol=https;AccountName=example;AccountKey=a2V5;EndpointSuffix=core.windows.net')",
        );
        const secrets = (await connection.runAndReadAll("SELECT * FROM duckdb_secrets()")).getRowObjectsJson();
        const secretTypes = (
          await connection.runAndReadAll("SELECT * FROM duckdb_secret_types() WHERE extension = 'azure' ORDER BY ALL")
        ).getRowObjectsJson();
        return { before, installed, loaded, secrets, secretTypes };
      },
      ":memory:",
      isolatedOptions(shared),
    ),
  NETWORK,
);

parity(
  "LOAD azure in a fresh instance after it was installed",
  async (api, { shared }) => {
    const options = isolatedOptions(shared);
    await withConnection(api, (connection) => connection.run("INSTALL azure"), ":memory:", options);
    return withConnection(
      api,
      async (connection) => {
        await connection.run("LOAD azure");
        return extensionRows(connection);
      },
      ":memory:",
      options,
    );
  },
  NETWORK,
);

parity(
  "LOAD of an extension that is not installed",
  (api, { tmp }) => withConnection(api, (connection) => connection.run("LOAD azure"), ":memory:", isolatedOptions(tmp)),
  { official: "error" },
);
