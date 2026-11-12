// Native memory handed to JavaScript, and what a function callback hands out.
//
// Copies. The official binding returns vector data, validity masks and string
// bytes with Napi::Buffer::NewOrCopy under NODE_API_NO_EXTERNAL_BUFFERS_ALLOWED
// (src/napi_setup.h), so each is a copy: writes reach the vector only through
// copy_data_to_vector. Each copy is mapped to the handle that owns the memory it
// came from, so get_data_from_pointer can follow a string pointer in the copy
// only while that memory is alive, and a reachable copy keeps its vector, and
// through the vector its data chunk, from being collected.
//
// Callback scopes. The info, data chunk and vector a function callback receives
// are borrowed for the length of the call: DuckDB frees or reuses them once the
// callback returns. A scope collects those handles and every handle derived from
// them (a chunk's vectors, a vector's children), then invalidates them when the
// callback returns, so a use after the callback throws instead of touching freed
// memory.
//
// User data. JavaScript objects handed to DuckDB (bind data, init data, scalar
// function state) cross as ids (native/ABI.md, "Function callbacks"); the
// objects live here until the shim reports that DuckDB dropped the id.

import { type Pointer, toArrayBuffer } from "bun:ffi";
import { allocateId, onRelease } from "./dispatch.ts";
import { Handle } from "./handle.ts";

// --- callback scopes ------------------------------------------------------------------

const scopes = new WeakMap<object, CallbackScope>();

export class CallbackScope {
  readonly #handles: Handle[] = [];

  /** Adds a handle that dies with the callback. */
  adopt<T extends Handle>(handle: T): T {
    this.#handles.push(handle);
    scopes.set(handle, this);
    return handle;
  }

  /** Invalidates every handle the callback was given or derived. */
  close(): void {
    for (const handle of this.#handles) handle.invalidate();
    this.#handles.length = 0;
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

// --- copies of native memory ----------------------------------------------------------

/** The handle that owns the memory each copy came from. */
const owners = new WeakMap<ArrayBuffer, Handle>();

/**
 * A Buffer holding a copy of `length` bytes of native memory at `pointer`, owned
 * by `owner`. A null pointer or a zero length gives an empty Buffer.
 */
export function nativeCopy(pointer: Pointer | number | null, length: number, owner: Handle | undefined): Buffer {
  if (!pointer || length === 0) return Buffer.alloc(0);
  const copy = Buffer.from(new Uint8Array(toArrayBuffer(pointer as Pointer, 0, length)));
  if (owner !== undefined) owners.set(copy.buffer as ArrayBuffer, owner);
  return copy;
}

/**
 * The owner of the memory a copy came from, so a string pointer inside the copy
 * can be followed. Throws when that memory is gone: its handle, or a handle it
 * borrows from, was destroyed or belonged to a callback that has returned.
 */
export function liveOwnerOfBuffer(buffer: ArrayBuffer): Handle | undefined {
  const owner = owners.get(buffer);
  for (let handle: unknown = owner; handle instanceof Handle; handle = handle.owner) {
    if (handle.ptr === null) throw new Error(`Invalid ${handle.kind} argument`);
  }
  return owner;
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
 * The message DuckDB reports for a thrown value, as the official binding's
 * Napi::Error::Message(): the value's "message" property when the value is an
 * object and that property is a string, otherwise an empty message. A thrown
 * string therefore fails the query with "Invalid Input Error: " and no text.
 */
export function messageOf(error: unknown): string {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
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
