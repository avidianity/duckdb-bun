// Waiting for native handles to return to a baseline after a load, shared by the leak test, the
// concurrency stress test and the soak.
//
// Collected handles free their pointers from the FinalizationRegistry, which runs after a GC.
// JavaScriptCore scans the stack conservatively, and a stale stack slot can keep an object alive:
// on the linux-arm64 runner one result outlived 20 collections. A leak of one handle per call
// leaves thousands, so allowing one extra per kind still catches it.
import { diagnostics } from "../../src/neo.ts";

/** The kinds with more than one handle over the baseline, as [kind, count] pairs. */
export function excessHandles(baseline: Record<string, number>): [string, number][] {
  return Object.entries(diagnostics().liveHandles).filter(([kind, n]) => n > (baseline[kind] ?? 0) + 1);
}

/** Collects until every kind is back at its baseline or `rounds` collections ran; returns the excess. */
export async function settleHandles(baseline: Record<string, number>, rounds = 50): Promise<[string, number][]> {
  const atBaseline = () => Object.entries(diagnostics().liveHandles).every(([kind, n]) => n <= (baseline[kind] ?? 0));
  for (let i = 0; i < rounds && !atBaseline(); i++) {
    Bun.gc(true);
    await Bun.sleep(20);
  }
  return excessHandles(baseline);
}
