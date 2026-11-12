// Writes the type declarations the package publishes, in dist/, from src/.
//
//   bun run build:types [out directory]
//
// A consumer's type checker reads them through the "types" condition of each export, so it never checks this
// package's source under the consumer's own compiler options: skipLibCheck skips .d.ts files, never .ts files,
// and a strict consumer reported hundreds of errors in the 1.0.1 source (ADR 0010). tsc writes a .d.ts for each
// .ts file, but does not copy hand-written .d.ts files, so this copies them, then checks that every export's
// "types" file exists.
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** The fields of package.json that name the published declarations. */
export interface Manifest {
  types?: string;
  exports?: Record<string, string | Record<string, string>>;
}

/** Every "types" file the manifest names, relative to the package root. */
export function typesEntries(manifest: Manifest): string[] {
  const named = [manifest.types];
  for (const target of Object.values(manifest.exports ?? {})) if (typeof target === "object") named.push(target.types);
  const entries = named.filter((entry) => entry !== undefined).map((entry) => entry.replace(/^\.\//, ""));
  return [...new Set(entries)].sort();
}

/** Writes the declarations of src/ to `out` (dist/ by default) and returns the "types" files it wrote. */
export async function buildTypes(out = join(ROOT, "dist")): Promise<string[]> {
  await rm(out, { recursive: true, force: true });
  // The bin starts with a node shebang; running it with Bun keeps Node out, as .rules requires.
  const tsc = join(dirname(Bun.resolveSync("typescript/package.json", ROOT)), "bin", "tsc");
  const build = Bun.spawnSync([process.execPath, tsc, "-p", join(ROOT, "tsconfig.types.json"), "--outDir", out], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) throw new Error(`tsc -p tsconfig.types.json exited with ${build.exitCode}`);

  for await (const file of new Bun.Glob("**/*.d.ts").scan({ cwd: join(ROOT, "src") })) {
    await mkdir(dirname(join(out, file)), { recursive: true });
    await Bun.write(join(out, file), Bun.file(join(ROOT, "src", file)));
  }

  // The manifest names dist/ files; map each to `out`.
  const manifest = (await Bun.file(join(ROOT, "package.json")).json()) as Manifest;
  const entries = typesEntries(manifest).map((entry) => join(out, relative("dist", entry)));
  const missing: string[] = [];
  for (const entry of entries) if (!(await Bun.file(entry).exists())) missing.push(entry);
  if (missing.length > 0) throw new Error(`package.json names types files that the build did not write: ${missing}`);
  return entries;
}

if (import.meta.main) {
  const [out] = Bun.argv.slice(2);
  const entries = await buildTypes(out === undefined ? undefined : resolve(out));
  console.log(`Wrote the declarations of src/, with ${entries.join(", ")}`);
}
