// Child process for issue-3060.test.ts. Runs the duckdb/duckdb#26441 query through
// one implementation of the @duckdb/node-api surface and prints the outcome as
// one JSON line. Usage: bun issue-3060-child.ts <ours|official> <temp dir>
import { assertRealOfficialBinding } from "../../official-binding.ts";

const [which, tempDirectory] = process.argv.slice(2);
if (which === "official") assertRealOfficialBinding();
const api = which === "official" ? await import("@duckdb/node-api") : await import("../../../src/neo.ts");

const SQL = `
WITH ref_rows AS (SELECT (i // 21) * 7 AS pos, 'A' AS allele_a, 'G' AS allele_b, i % 21 AS g,
    (i % 97) / 97.0 AS frequency FROM range(2331000) t(i)),
calls AS (SELECT 's' || s AS smp, 'chr20' AS chrom, p AS pos, 'A' AS ref, 'G' AS alt,
    (p % 2)::VARCHAR || '|' || (s % 2)::VARCHAR AS evidence
    FROM (SELECT s, unnest(range(850000)) AS p FROM (SELECT unnest(range(64)) AS s))),
vcf_sites AS (SELECT DISTINCT chrom, pos, ref, alt FROM calls),
ref AS (SELECT c.chrom, r.pos, any_value(r.allele_a) AS ref, any_value(r.allele_b) AS alt,
    list(r.frequency ORDER BY r.g) AS frequencies
    FROM ref_rows AS r JOIN vcf_sites AS c ON c.pos = r.pos AND c.ref = r.allele_a AND c.alt = r.allele_b
    GROUP BY c.chrom, r.pos),
sites AS (SELECT c.chrom, c.pos, c.smp, list_sum(r.frequencies) AS af, c.evidence
    FROM calls AS c
    LEFT JOIN ref AS r ON c.chrom = r.chrom AND c.pos = r.pos AND c.ref = r.ref AND c.alt = r.alt),
lists AS (SELECT smp, chrom, list(struct_pack(pos := pos, af := af, e := evidence)) AS s FROM sites GROUP BY smp, chrom)
SELECT count(*) AS lists, sum(len(s)) AS sites FROM lists`;

const instance = await api.DuckDBInstance.create(":memory:");
const connection = await instance.connect();
await connection.run("SET memory_limit = '2GB'");
await connection.run("SET threads = 4");
await connection.run(`SET temp_directory = '${tempDirectory}'`);
// Caps spilling, so the query ends in an Out of Memory error rather than
// completing after writing gigabytes to disk.
await connection.run("SET max_temp_directory_size = '1GB'");
try {
  const reader = await connection.runAndReadAll(SQL);
  console.log(JSON.stringify({ outcome: "completed", rows: reader.getRowsJson() }));
} catch (error) {
  console.log(JSON.stringify({ outcome: "error", message: error instanceof Error ? error.message : String(error) }));
}
connection.closeSync();
instance.closeSync();
