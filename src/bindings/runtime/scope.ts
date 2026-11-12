// Native memory handed to JavaScript, and what a function callback hands out.
//
// Views. The official binding returns vector data, validity masks and string
// bytes as external buffers over DuckDB's memory (Napi::Buffer::NewOrCopy), and
// nothing keeps the owner of that memory alive. Here each view's ArrayBuffer is
// mapped to the handle that owns the memory, so a reachable view keeps its
// vector, and through the vector its data chunk, from being collected.
//
// Callback scopes. The info, data chunk and vector a function callback receives
// are borrowed for the length of the call: DuckDB frees or reuses them once the
// callback returns. A scope collects those handles, every handle derived from
// them (a chunk's vectors, a vector's children) and every view over their
// memory, then invalidates the handles and detaches the views when the callback
// returns, so a use after the callback throws instead of touching freed memory.
//
// User data. JavaScript objects handed to DuckDB (bind data, init data, scalar
// function state) cross as ids (native/ABI.md, "Function callbacks"); the
// objects live here until the shim reports that DuckDB dropped the id.

import { type Pointer, toArrayBuffer } from "bun:ffi";
import { allocateId, onRelease } from "./dispatch.ts";
import type { Handle } from "./handle.ts";

// --- callback scopes ------------------------------------------------------------------

const scopes = new WeakMap<object, CallbackScope>();

export class CallbackScope {
  readonly #handles: Handle[] = [];
  readonly #buffers: ArrayBuffer[] = [];

  /** Adds a handle that dies with the callback. */
  adopt<T extends Handle>(handle: T): T {
    this.#handles.push(handle);
    scopes.set(handle, this);
    return handle;
  }

  addBuffer(buffer: ArrayBuffer): void {
    this.#buffers.push(buffer);
    scopes.set(buffer, this);
  }

  /** Invalidates every handle and detaches every view the callback was given or derived. */
  close(): void {
    for (const handle of this.#handles) handle.invalidate();
    // transfer(0) detaches the view's buffer without copying or freeing the
    // native memory behind it, so later reads see an empty buffer.
    for (const buffer of this.#buffers) buffer.transfer(0);
    this.#handles.length = 0;
    this.#buffers.length = 0;
  }
}

/**
 * A handle derived from `owner` (a vector of a chunk, a child of a vector):
 * when the owner belongs to a callback, the derived handle dies with it too.
 */
export function derived<T extends Handle>(owner: object, handle: T): T {
  scopes.get(owner)?.adopt(handle);
  return handle;
}

// --- views over native memory ----------------------------------------------------------

/** The handle that owns the memory behind each view's ArrayBuffer. */
const owners = new WeakMap<ArrayBuffer, object>();

/**
 * A Buffer over `length` bytes of native memory at `pointer`, owned by `owner`.
 * A null pointer or a zero length gives an empty Buffer, since bun:ffi cannot
 * view either.
 */
export function nativeView(pointer: Pointer | number | null, length: number, owner: object | undefined): Buffer {
  if (!pointer || length === 0) return Buffer.alloc(0);
  const buffer = toArrayBuffer(pointer as Pointer, 0, length);
  if (owner !== undefined) {
    owners.set(buffer, owner);
    scopes.get(owner)?.addBuffer(buffer);
  }
  return Buffer.from(buffer);
}

/** The owner of a view's memory, so a view derived from it (a string's bytes) can share it. */
export function ownerOfBuffer(buffer: ArrayBuffer): object | undefined {
  return owners.get(buffer);
}

// --- user data ---------------------------------------------------------------------------

const userData = new Map<number, unknown>();

/** Stores `value` under a new id that is dropped when DuckDB releases it. */
export function storeUserData(value: unknown): number {
  const id = allocateId();
  userData.set(id, value);
  onRelease(id, () => userData.delete(id));
  return id;
}

/** The value stored under `id`, or undefined for 0 (none) or a released id. */
export function userDataOf(id: number | bigint): unknown {
  return userData.get(Number(id));
}

// --- running user callbacks ----------------------------------------------------------------

/**
 * The message DuckDB reports for a thrown value: an Error's message, as the
 * official binding's Napi::Error::Message(), or the value as a string.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a user callback inside `scope`. A throw is reported through `setError`,
 * as the official binding's DuckDBThreadCallbackDispatch does, and the scope is
 * closed whatever happens.
 */
export function runInScope(scope: CallbackScope, run: () => void, setError: (message: string) => void): void {
  try {
    run();
  } catch (error) {
    setError(messageOf(error));
  } finally {
    scope.close();
  }
}
