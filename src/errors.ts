// A real Error subclass so callers can keep
// using `err instanceof Error` and message regex checks (e.g. /Out of Memory/i).
export class DuckDBError extends Error {
  readonly duckdbMessage: string;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DuckDBError";
    this.duckdbMessage = message;
  }
}

/** Runs `action`, rethrowing any error as a DuckDBError with the same message and the original as its cause. */
export async function asDuckDBError<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof DuckDBError) throw error;
    throw new DuckDBError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

/** The synchronous form of asDuckDBError. */
export function asDuckDBErrorSync<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof DuckDBError) throw error;
    throw new DuckDBError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}
