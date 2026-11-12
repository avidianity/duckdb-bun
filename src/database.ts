import { DuckDBInstance as OfficialInstance } from "../vendor/node-api/src/index.ts";
import { DuckDBConnection } from "./connection.ts";
import { asDuckDBError } from "./errors.ts";

/** A DuckDB database instance. Use `:memory:` for an ephemeral in-memory DB. */
export class DuckDBInstance {
  #instance: OfficialInstance;
  #closed = false;

  private constructor(instance: OfficialInstance) {
    this.#instance = instance;
  }

  static async create(path = ":memory:"): Promise<DuckDBInstance> {
    return new DuckDBInstance(await asDuckDBError(() => OfficialInstance.create(path)));
  }

  async connect(): Promise<DuckDBConnection> {
    return new DuckDBConnection(await asDuckDBError(() => this.#instance.connect()));
  }

  closeSync(): void {
    if (this.#closed) return;
    this.#instance.closeSync();
    this.#closed = true;
  }
}
