// Reads the headers of the native libraries a platform package ships, for scripts/first-publish.ts.
// Pure functions over the file's bytes, so tests/native-file.test.ts covers every platform on any host.

/** ELF e_machine values (EM_X86_64, EM_AARCH64 in <elf.h>), by the npm `cpu` name of each architecture. */
const ELF_MACHINE: Record<number, string> = { 62: "x64", 183: "arm64" };
/** Mach-O cputype values (CPU_TYPE_X86_64, CPU_TYPE_ARM64 in <mach/machine.h>). */
const MACHO_CPU: Record<number, string> = { 16777223: "x64", 16777228: "arm64" };

/**
 * The CPU architectures in a shared library's header, as npm `cpu` names: ELF, thin Mach-O, or a universal
 * Mach-O such as DuckDB's macOS release, which holds both arm64 and x64.
 */
export function architectures(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) === 0x7f454c46) {
    if (bytes[4] !== 2) return ["ELF32"];
    const machine = view.getUint16(18, true);
    return [ELF_MACHINE[machine] ?? `ELF machine ${machine}`];
  }
  const cpu = (type: number) => MACHO_CPU[type] ?? `Mach-O cputype ${type}`;
  if (view.getUint32(0, true) === 0xfeedfacf) return [cpu(view.getUint32(4, true))];
  if (view.getUint32(0, false) === 0xcafebabe) {
    const count = view.getUint32(4, false);
    return Array.from({ length: count }, (_, index) => cpu(view.getUint32(8 + index * 20, false)));
  }
  return ["unknown"];
}

/** The newest GLIBC_2.<n> symbol version an ELF file refers to, or 0 when it refers to none. */
export function newestGlibcMinor(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  return Math.max(0, ...[...text.matchAll(/GLIBC_2\.(\d+)/g)].map((m) => Number(m[1])));
}
