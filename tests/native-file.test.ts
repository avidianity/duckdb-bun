// The header checks scripts/first-publish.ts runs on every native library before publishing
// (scripts/native-file.ts), on synthetic headers, so every platform is covered on any host.
import { describe, expect, test } from "bun:test";
import { architectures, newestGlibcMinor } from "../scripts/native-file.ts";

/** The first 64 bytes of a little-endian ELF file of the given class and e_machine. */
function elf(machine: number, elfClass = 2): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, elfClass, 1, 1]);
  new DataView(bytes.buffer).setUint16(18, machine, true);
  return bytes;
}

/** A thin 64-bit Mach-O header (MH_MAGIC_64, little-endian) with the given cputype. */
function machO(cpu: number): Uint8Array {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setUint32(4, cpu, true);
  return bytes;
}

/** A universal Mach-O header (FAT_MAGIC, big-endian) listing the given cputypes. */
function fat(...cpus: number[]): Uint8Array {
  const bytes = new Uint8Array(8 + cpus.length * 20);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xcafebabe, false);
  view.setUint32(4, cpus.length, false);
  for (const [index, cpu] of cpus.entries()) view.setUint32(8 + index * 20, cpu, false);
  return bytes;
}

describe("architectures", () => {
  test("names ELF x86-64 and AArch64 the way npm's cpu field does", () => {
    expect(architectures(elf(62))).toEqual(["x64"]);
    expect(architectures(elf(183))).toEqual(["arm64"]);
  });

  test("reports another ELF machine or a 32-bit ELF file, so the check fails", () => {
    expect(architectures(elf(40))).toEqual(["ELF machine 40"]);
    expect(architectures(elf(183, 1))).toEqual(["ELF32"]);
  });

  test("reads thin and universal Mach-O files", () => {
    expect(architectures(machO(0x0100000c))).toEqual(["arm64"]);
    expect(architectures(fat(0x01000007, 0x0100000c))).toEqual(["x64", "arm64"]);
  });

  test("reports a file that is neither", () => {
    expect(architectures(new Uint8Array(64))).toEqual(["unknown"]);
  });
});

describe("newestGlibcMinor", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  test("returns the newest GLIBC_2.<n> version, compared as a number", () => {
    expect(newestGlibcMinor(encode("\0GLIBC_2.17\0GLIBC_2.9\0GLIBC_2.34\0GLIBC_PRIVATE\0"))).toBe(34);
  });

  test("returns 0 for a file that names no glibc version", () => {
    expect(newestGlibcMinor(encode("\0libSystem.B.dylib\0"))).toBe(0);
  });
});
