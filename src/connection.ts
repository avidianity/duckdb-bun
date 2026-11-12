import type { DuckDBConnection as OfficialConnection } from "./api/index.ts";
import { asDuckDBError } from "./errors.ts";
import { type Reader, readerFrom } from "./reader.ts";
import { PreparedStatement } from "./statement.ts";

/** A DuckDB connection. Drop-in for the @duckdb/node-api slice used downstream. */
export class DuckDBConnection {
  #connection: OfficialConnection;
  #closed = false;

  constructor(connection: OfficialConnection) {
    this.#connection = connection;
  }

  /** Execute a statement and ignore any result rows. */
  async run(sql: string): Promise<void> {
    await asDuckDBError(() => this.#connection.run(sql));
  }

  /** Execute a query and read every row into a Reader. */
  async runAndReadAll(sql: string): Promise<Reader> {
    return readerFrom(await asDuckDBError(() => this.#connection.runAndReadAll(sql)));
  }

  /** Prepare a parameterized statement. */
  async prepare(sql: string): Promise<PreparedStatement> {
    return new PreparedStatement(await asDuckDBError(() => this.#connection.prepare(sql)));
  }

  closeSync(): void {
    if (this.#closed) return;
    this.#connection.closeSync();
    this.#closed = true;
  }
}
