import type { DuckDBPreparedStatement } from "../vendor/node-api/src/index.ts";
import { asDuckDBError, asDuckDBErrorSync } from "./errors.ts";
import { type Reader, readerFrom } from "./reader.ts";

const INT64_MIN = -9_223_372_036_854_775_808n;
const INT64_MAX = 9_223_372_036_854_775_807n;

/** A prepared statement with 1-based parameter binding. */
export class PreparedStatement {
  #statement: DuckDBPreparedStatement;
  #closed = false;

  constructor(statement: DuckDBPreparedStatement) {
    this.#statement = statement;
  }

  /** Number of `?` parameters in the statement. */
  get paramCount(): number {
    return this.#statement.parameterCount;
  }

  /** Bind a single 1-based parameter, dispatching by JS type. */
  bind(index: number, value: unknown): this {
    const statement = this.#statement;
    asDuckDBErrorSync(() => {
      if (value === null || value === undefined) statement.bindNull(index);
      else if (typeof value === "boolean") statement.bindBoolean(index, value);
      else if (typeof value === "bigint") {
        if (value >= INT64_MIN && value <= INT64_MAX) statement.bindBigInt(index, value);
        else statement.bindVarchar(index, value.toString());
      } else if (typeof value === "number") {
        if (Number.isSafeInteger(value)) statement.bindBigInt(index, BigInt(value));
        else statement.bindDouble(index, value);
      } else if (value instanceof Date) statement.bindVarchar(index, value.toISOString());
      else statement.bindVarchar(index, String(value));
    });
    return this;
  }

  /** Bind all parameters positionally (1-based under the hood). */
  bindAll(values: unknown[]): this {
    for (let i = 0; i < values.length; i++) this.bind(i + 1, values[i]);
    return this;
  }

  /** Execute and discard the result. */
  async run(): Promise<void> {
    await asDuckDBError(() => this.#statement.run());
  }

  /** Execute and read every row. */
  async readAll(): Promise<Reader> {
    return readerFrom(await asDuckDBError(() => this.#statement.runAndReadAll()));
  }

  close(): void {
    if (this.#closed) return;
    this.#statement.destroySync();
    this.#closed = true;
  }
}
