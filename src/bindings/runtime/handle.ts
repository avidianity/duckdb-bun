// Typed handle objects for every native pointer the bindings hand to JavaScript
// (docs/adr/0002-handles-are-objects-freed-by-a-finalization-registry.md).
//
// Each handle mirrors one N-API external of the official binding
// (bindings/src/externals.h at the vendored tag): it carries a kind that plays
// the role of the external's type tag, so passing the wrong handle throws the
// same "Invalid <kind> argument" error, and a destroy function that a
// FinalizationRegistry runs once the handle is unreachable.
//
// A native call that uses a handle counts itself in `inFlight` for as long as it
// runs. An explicit destroy (close_sync, disconnect_sync, destroy_*_sync) during
// that time only sets `destroyRequested`, and the last call to finish destroys
// the pointer. The official binding does this for results and pending results;
// here every handle a native thread can use follows the rule, so close_sync and
// disconnect_sync during a query never free memory a native thread is using.

import type { Pointer } from "bun:ffi";

export type Kind =
  | "appender"
  | "catalog"
  | "catalog entry"
  | "client context"
  | "config"
  | "connection"
  | "data chunk"
  | "database"
  | "extracted statements"
  | "instance cache"
  | "logical type"
  | "pending result"
  | "prepared statement"
  | "result"
  | "scalar function"
  | "scalar function bind info"
  | "scalar function info"
  | "scalar function init info"
  | "table function"
  | "table function bind info"
  | "table function info"
  | "table function init info"
  | "value"
  | "vector";

/** Kinds whose explicit destroy makes later use throw, as in the official binding. */
const DESTROYED_MESSAGE: Partial<Record<Kind, string>> = {
  result: "Result destroyed",
  "pending result": "Pending result destroyed",
};

type Destroy = (ptr: Pointer) => void;

/** The native state of one handle, shared with the FinalizationRegistry. It
 * never references the Handle itself, so it does not keep it alive. */
interface Cell {
  ptr: Pointer | null;
  readonly destroy: Destroy | null;
  inFlight: number;
  destroyRequested: boolean;
}

function destroyCell(cell: Cell): void {
  const { ptr, destroy } = cell;
  cell.ptr = null;
  if (ptr !== null && destroy) destroy(ptr);
}

const registry = new FinalizationRegistry<Cell>((cell) => {
  // A native call holds a strong reference to its handles until it completes,
  // so a collected handle has no call in flight; the check is defensive.
  if (cell.inFlight === 0) destroyCell(cell);
});

export class Handle<K extends Kind = Kind> {
  readonly kind: K;
  readonly #cell: Cell;
  /** Keeps the handle this one borrows from (a data chunk for its vectors) alive. */
  readonly #owner: object | undefined;

  constructor(kind: K, ptr: Pointer | null, destroy: Destroy | null, owner?: object) {
    this.kind = kind;
    this.#cell = { ptr, destroy, inFlight: 0, destroyRequested: false };
    this.#owner = owner;
    if (destroy && ptr !== null) registry.register(this, this.#cell, this.#cell);
  }

  /** The native pointer, or null once destroyed. */
  get ptr(): Pointer | null {
    return this.#cell.ptr;
  }

  get owner(): object | undefined {
    return this.#owner;
  }

  get destroyRequested(): boolean {
    return this.#cell.destroyRequested;
  }

  /** True for a pointer owned elsewhere, which this handle never frees. */
  get borrowed(): boolean {
    return this.#cell.destroy === null;
  }

  /** Marks a native call as using this handle until `release` is called. */
  acquire(): void {
    this.#cell.inFlight++;
  }

  release(): void {
    const cell = this.#cell;
    cell.inFlight--;
    if (cell.destroyRequested && cell.inFlight === 0) this.#finish();
  }

  /** Explicit destroy: now, or when the last native call using the handle completes. */
  requestDestroy(): void {
    const cell = this.#cell;
    cell.destroyRequested = true;
    if (cell.inFlight === 0) this.#finish();
  }

  /** Invalidates a borrowed handle, such as a callback's info once the callback returns. */
  invalidate(): void {
    this.#cell.ptr = null;
    this.#cell.destroyRequested = true;
  }

  #finish(): void {
    registry.unregister(this.#cell);
    destroyCell(this.#cell);
  }
}

/** Wraps an owned pointer, freed by `destroy` when collected or explicitly destroyed. */
export function owned<K extends Kind>(kind: K, ptr: Pointer, destroy: Destroy): Handle<K> {
  return new Handle(kind, ptr, destroy);
}

/** Wraps a pointer owned elsewhere (a vector of a data chunk, a callback's info). */
export function borrowed<K extends Kind>(kind: K, ptr: Pointer | null, owner?: object): Handle<K> {
  return new Handle(kind, ptr, null, owner);
}

/**
 * The pointer behind `value`, checked like the official binding's type tags.
 *
 * After an explicit destroy, a result or pending result throws the official
 * "... destroyed" error, an invalidated borrowed handle throws the type error,
 * and any other handle reads as null, the pointer the official binding's
 * destroy leaves behind (so a query on it fails with "connection disconnected").
 */
export function unwrap(value: unknown, kind: Kind): Pointer | null {
  if (!(value instanceof Handle) || value.kind !== kind) throw new Error(`Invalid ${kind} argument`);
  if (!value.destroyRequested) return value.ptr;
  const destroyed = DESTROYED_MESSAGE[kind];
  if (destroyed) throw new Error(destroyed);
  if (value.borrowed) throw new Error(`Invalid ${kind} argument`);
  return null;
}

/** Like `unwrap`, but returns the Handle itself, for calls that must acquire it. */
export function handleOf<K extends Kind>(value: unknown, kind: K): Handle<K> {
  unwrap(value, kind);
  return value as Handle<K>;
}
