// Shared pieces of the long-running load checks: the concurrency stress test
// (tests/heavy/concurrency-stress.test.ts) and the soak run (scripts/soak.ts).

import { readdirSync, readFileSync } from "node:fs";

/** A seeded pseudo-random generator (mulberry32), so a failing run repeats with its printed seed. */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** A float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  }

  /** A generator for one lane, so each lane's choices depend on the seed and the lane only. */
  fork(lane: number): Random {
    return new Random(Math.imul(this.state ^ (lane * 0x9e3779b9), 0x85ebca6b) ^ lane);
  }
}

/** A seed from `name` in the environment, or a fresh one. */
export function seedFrom(name: string): number {
  const configured = process.env[name];
  if (configured !== undefined && configured !== "") {
    const seed = Number(configured);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new Error(`${name} must be an integer from 0 to 4294967295, got ${configured}`);
    }
    return seed;
  }
  return Math.floor(Math.random() * 0x100000000);
}

/** A positive number from `name` in the environment, or `fallback`. */
export function numberFrom(name: string, fallback: number): number {
  const configured = process.env[name];
  if (configured === undefined || configured === "") return fallback;
  const value = Number(configured);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got ${configured}`);
  return value;
}

/** The value at quantile `q` (0 to 1) of `values`, or 0 for none. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

/**
 * Measures how late a 10 ms timer fires. A JS thread that waits for a query shows
 * up as one gap as long as the query.
 */
export class EventLoopProbe {
  static readonly TICK_MS = 10;
  private gaps: number[] = [];
  private last = performance.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      this.gaps.push(now - this.last);
      this.last = now;
    }, EventLoopProbe.TICK_MS);
  }

  /** Stops the timer; gaps measured so far stay readable. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The gaps since the last call, and starts a new window. */
  take(): number[] {
    const gaps = this.gaps;
    this.gaps = [];
    return gaps;
  }
}

/** The names of this process's threads, from Linux procfs; null where procfs does not list them. */
export function threadNames(): string[] | null {
  if (process.platform !== "linux") return null;
  const names: string[] = [];
  for (const task of readdirSync("/proc/self/task")) {
    try {
      names.push(readFileSync(`/proc/self/task/${task}/comm`, "utf8").trim());
    } catch (error) {
      // A thread that exits between the listing and the read has no comm file left.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return names;
}

/**
 * The shim's job threads alive, busy or idle, by their OS name `duckdb-bun:pool`
 * (docs/adr/0006). A running job renames its thread only in the crash report,
 * not in the OS. Null where procfs does not list thread names.
 */
export function poolThreads(): number | null {
  const names = threadNames();
  return names === null ? null : names.filter((name) => name === "duckdb-bun:pool").length;
}
