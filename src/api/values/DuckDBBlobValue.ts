// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { bytesFromString } from "../conversion/bytesFromString";
import { stringFromBlob } from "../conversion/stringFromBlob";

export class DuckDBBlobValue {
  public readonly bytes: Uint8Array;

  public constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /** Matches BLOB-to-VARCHAR conversion behavior of DuckDB. */
  public toString(): string {
    return stringFromBlob(this.bytes);
  }

  public static fromString(str: string): DuckDBBlobValue {
    return new DuckDBBlobValue(Buffer.from(bytesFromString(str)));
  }
}

export function blobValue(input: Uint8Array | string): DuckDBBlobValue {
  if (typeof input === "string") {
    return DuckDBBlobValue.fromString(input);
  }
  return new DuckDBBlobValue(input);
}
