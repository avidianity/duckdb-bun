// Instance cache, database, config, connection, client context and catalog
// functions of the @duckdb/node-bindings contract. Semantics and error text
// follow the official binding (bindings/src/duckdb_node_bindings.cpp and
// promise_workers.h at the vendored tag).
import type { Pointer } from "bun:ffi";
import type {
  Catalog,
  CatalogEntry,
  CatalogEntryType,
  ClientContext,
  Config,
  ConfigFlag,
  Connection,
  Database,
  InstanceCache,
  QueryProgress,
  Value,
} from "../generated/contract.ts";
import { expectString, integerFromNumber } from "../runtime/convert.ts";
import { jobOut0, runJob } from "../runtime/dispatch.ts";
import { type Handle, handleOf, unwrap } from "../runtime/handle.ts";
import { own } from "../runtime/kinds.ts";
import { cstr, decode, readCString, slot, slotValue, structBuffer, utf8 } from "../runtime/marshal.ts";
import { duckdb, shim } from "../runtime/native.ts";
import { RingOp, record } from "../runtime/ring.ts";

/** The `duckdb_api` value the official binding sets on every config it creates. */
const DEFAULT_DUCKDB_API = "node-neo-bindings";

function asHandle<T>(handle: Handle): T {
  return handle as unknown as T;
}

function databaseFrom(job: Pointer): Database {
  return asHandle<Database>(own("database", jobOut0(job) as Pointer));
}

// --- instance cache and open ---------------------------------------------------------

export function create_instance_cache(): InstanceCache {
  return asHandle(own("instance cache", duckdb.duckdb_create_instance_cache() as Pointer));
}

export function get_or_create_from_cache(cache: InstanceCache, path?: string, config?: Config): Promise<Database> {
  const cacheHandle = handleOf(cache, "instance cache");
  const configHandle = config === undefined ? undefined : handleOf(config, "config");
  const { bytes, length } = utf8(path ?? "");
  const handles = configHandle ? [cacheHandle, configHandle] : [cacheHandle];
  return runJob(
    handles,
    () =>
      shim.dbs_job_get_or_create_from_cache(
        cacheHandle.ptr,
        bytes,
        length,
        path !== undefined,
        configHandle?.ptr ?? null,
      ) as Pointer | null,
    databaseFrom,
  );
}

export function open(path?: string, config?: Config): Promise<Database> {
  const configHandle = config === undefined ? undefined : handleOf(config, "config");
  const { bytes, length } = utf8(path ?? "");
  return runJob(
    configHandle ? [configHandle] : [],
    () => shim.dbs_job_open(bytes, length, path !== undefined, configHandle?.ptr ?? null) as Pointer | null,
    databaseFrom,
  );
}

export function close_sync(database: Database): void {
  const handle = handleOf(database, "database");
  record(RingOp.close, handle.ptr);
  handle.requestDestroy();
}

export function library_version(): string {
  return readCString(duckdb.duckdb_library_version() as Pointer) ?? "";
}

// --- config -------------------------------------------------------------------------

export function create_config(): Config {
  const out = slot();
  if (duckdb.duckdb_create_config(out)) {
    duckdb.duckdb_destroy_config(out);
    throw new Error("Failed to create config");
  }
  const config = own("config", slotValue(out) as Pointer);
  if (duckdb.duckdb_set_config(config.ptr, cstr("duckdb_api"), cstr(DEFAULT_DUCKDB_API))) {
    throw new Error("Failed to set duckdb_api");
  }
  return asHandle(config);
}

export function config_count(): number {
  return Number(duckdb.duckdb_config_count());
}

export function get_config_flag(index: number): ConfigFlag {
  const name = slot();
  const description = slot();
  if (duckdb.duckdb_get_config_flag(index, name, description)) throw new Error("Config option not found");
  return { name: readCString(slotValue(name)) ?? "", description: readCString(slotValue(description)) ?? "" };
}

export function set_config(config: Config, name: string, option: string): void {
  if (duckdb.duckdb_set_config(unwrap(config, "config"), cstr(name), cstr(option))) {
    throw new Error("Failed to set config");
  }
}

// --- connection ---------------------------------------------------------------------

export function connect(database: Database): Promise<Connection> {
  const handle = handleOf(database, "database");
  return runJob(
    [handle],
    () => shim.dbs_job_connect(handle.destroyRequested ? null : handle.ptr) as Pointer | null,
    (job) => asHandle<Connection>(own("connection", jobOut0(job) as Pointer)),
  );
}

export function interrupt(connection: Connection): void {
  const ptr = unwrap(connection, "connection");
  record(RingOp.interrupt, ptr);
  duckdb.duckdb_interrupt(ptr);
}

export function query_progress(connection: Connection): QueryProgress {
  const out = structBuffer("query_progress_type");
  shim.dbs_query_progress(unwrap(connection, "connection"), out);
  return decode<QueryProgress>("query_progress_type", out);
}

export function disconnect_sync(connection: Connection): void {
  const handle = handleOf(connection, "connection");
  record(RingOp.disconnect, handle.ptr);
  handle.requestDestroy();
}

export function connection_get_client_context(connection: Connection): ClientContext {
  const out = slot();
  duckdb.duckdb_connection_get_client_context(unwrap(connection, "connection"), out);
  const context = slotValue(out);
  if (context === null) throw new Error("Failed to get client context");
  return asHandle(own("client context", context));
}

export function client_context_get_connection_id(client_context: ClientContext): number {
  return Number(duckdb.duckdb_client_context_get_connection_id(unwrap(client_context, "client context")));
}

export function get_table_names(connection: Connection, query: string, qualified: boolean): Value {
  const value = duckdb.duckdb_get_table_names(unwrap(connection, "connection"), cstr(query), qualified) as Pointer;
  return asHandle(own("value", value));
}

// --- catalog ------------------------------------------------------------------------

/** DUCKDB_CATALOG_ENTRY_TYPE_DATABASE, the highest catalog entry type. */
const CATALOG_ENTRY_TYPE_DATABASE = 9;

/** Entry types the built-in duckdb catalog cannot look up, by duckdb_catalog_entry_type value. */
const UNSUPPORTED_DUCKDB_CATALOG_ENTRY_TYPES: Readonly<Record<number, string>> = {
  0: "INVALID",
  2: "SCHEMA",
  5: "PREPARED_STATEMENT",
  9: "DATABASE",
};

export function client_context_get_catalog(context: ClientContext, catalog_name: string): Catalog | null {
  const catalog = duckdb.duckdb_client_context_get_catalog(
    unwrap(context, "client context"),
    cstr(catalog_name),
  ) as Pointer | null;
  return catalog === null ? null : asHandle(own("catalog", catalog));
}

export function catalog_get_type_name(catalog: Catalog): string {
  return readCString(duckdb.duckdb_catalog_get_type_name(unwrap(catalog, "catalog")) as Pointer | null) ?? "";
}

export function catalog_get_entry(
  catalog: Catalog,
  context: ClientContext,
  entry_type: CatalogEntryType,
  schema_name: string,
  entry_name: string,
): CatalogEntry | null {
  const catalogPtr = unwrap(catalog, "catalog");
  const contextPtr = unwrap(context, "client context");
  const type = integerFromNumber(entry_type, "uint32", "entry_type");
  if (type > CATALOG_ENTRY_TYPE_DATABASE) throw new RangeError("Invalid catalog entry type");
  const schema = expectString(schema_name);
  const name = expectString(entry_name);
  if (schema.includes("\0") || name.includes("\0")) {
    throw new Error("Catalog entry names must not contain null bytes");
  }
  // Extension catalogs may support different lookup categories.
  const unsupported = UNSUPPORTED_DUCKDB_CATALOG_ENTRY_TYPES[type];
  if (unsupported && catalog_get_type_name(catalog) === "duckdb") {
    throw new Error(`Catalog entry type ${unsupported} is not supported by duckdb catalog lookups`);
  }
  const entry = duckdb.duckdb_catalog_get_entry(
    catalogPtr,
    contextPtr,
    type,
    cstr(schema),
    cstr(name),
  ) as Pointer | null;
  return entry === null ? null : asHandle(own("catalog entry", entry));
}

export function catalog_entry_get_type(entry: CatalogEntry): CatalogEntryType {
  return duckdb.duckdb_catalog_entry_get_type(unwrap(entry, "catalog entry")) as CatalogEntryType;
}

export function catalog_entry_get_name(entry: CatalogEntry): string {
  return readCString(duckdb.duckdb_catalog_entry_get_name(unwrap(entry, "catalog entry")) as Pointer | null) ?? "";
}
