// Writes the input files the ingest scenarios read: newline-delimited JSON and CSV with
// the same rows. Generated in plain JavaScript, not through either implementation, so
// neither side pays for or benefits from the generation.
import { join } from "node:path";

export interface DataFiles {
  json: string;
  csv: string;
}

const BASE_MS = Date.UTC(2024, 0, 1);
const FLUSH_BYTES = 4 * 1024 * 1024;

/** `YYYY-MM-DD HH:MM:SS`, the form DuckDB's sniffers detect as TIMESTAMP. */
function timestamp(i: number): string {
  return new Date(BASE_MS + i * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export async function writeDataFiles(dir: string, rows: number): Promise<DataFiles> {
  const files: DataFiles = { json: join(dir, "rows.ndjson"), csv: join(dir, "rows.csv") };
  const json = Bun.file(files.json).writer({ highWaterMark: FLUSH_BYTES });
  const csv = Bun.file(files.csv).writer({ highWaterMark: FLUSH_BYTES });
  csv.write("id,name,score,ts,amount\n");
  for (let i = 0; i < rows; i++) {
    const name = `name-${i}`;
    const score = i * 1.5;
    const ts = timestamp(i);
    const amount = ((i % 100_000) / 100).toFixed(2);
    json.write(
      `{"id":${i},"name":"${name}","score":${score},"ts":"${ts}","amount":${amount},"tags":[${i},${i + 1},${i + 2}]}\n`,
    );
    csv.write(`${i},${name},${score},${ts},${amount}\n`);
  }
  await Promise.all([json.end(), csv.end()]);
  return files;
}
