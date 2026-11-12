import type { DuckDBDataChunk } from "./DuckDBDataChunk";
import type { DuckDBValue } from "./values";

export function getRowObjectsFromChunks(
  chunks: readonly DuckDBDataChunk[],
  columnNames: readonly string[],
): Record<string, DuckDBValue>[] {
  const rowObjects: Record<string, DuckDBValue>[] = [];
  for (const chunk of chunks) {
    chunk.appendToRowObjects(columnNames, rowObjects);
  }
  return rowObjects;
}
