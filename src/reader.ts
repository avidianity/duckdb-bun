// The native-JS value mapping over the src/api reader: the
// official JS converter, except that DATE, TIME, TIME_TZ, TIME_NS and BIT come
// back as their SQL text (DATE as YYYY-MM-DD). Nested values use the same mapping.
import {
  type DuckDBResultReader,
  DuckDBTypeId,
  type DuckDBValueConverter,
  JSDuckDBValueConverter,
} from "./api/index.ts";

const AS_TEXT = new Set<DuckDBTypeId>([
  DuckDBTypeId.DATE,
  DuckDBTypeId.TIME,
  DuckDBTypeId.TIME_TZ,
  DuckDBTypeId.TIME_NS,
  DuckDBTypeId.BIT,
]);

const nativeJsConverter: DuckDBValueConverter<unknown> = (value, type, converter) => {
  if (value === null) return null;
  if (AS_TEXT.has(type.typeId)) return String(value);
  return JSDuckDBValueConverter(value, type, converter as never);
};

/** A materialized query result. Mirrors the slice of @duckdb/node-api's reader used downstream. */
export class Reader {
  #columns: string[];
  #rows: Record<string, unknown>[];
  constructor(columns: string[], rows: Record<string, unknown>[]) {
    this.#columns = columns;
    this.#rows = rows;
  }
  columnNames(): string[] {
    return this.#columns;
  }
  getRowObjects(): Record<string, unknown>[] {
    return this.#rows;
  }
  get rowCount(): number {
    return this.#rows.length;
  }
}

/** Converts a fully read official reader into a native-JS Reader. */
export function readerFrom(reader: DuckDBResultReader): Reader {
  return new Reader(reader.columnNames(), reader.convertRowObjects(nativeJsConverter) as Record<string, unknown>[]);
}
