// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import type duckdb from "../../bindings/index.ts";
import type { DuckDBType } from "../DuckDBType";
import type { DuckDBValue } from "../values";
import type { DuckDBVector } from "./DuckDBVector";

export type CreateDuckDBVectorFn = (
  vector: duckdb.Vector,
  itemCount: number,
  knownType?: DuckDBType,
) => DuckDBVector<DuckDBValue>;

/**
 * @internal
 * Holds the concrete {@link DuckDBVector.create} implementation, assigned by
 * ./createVector when the vectors module graph loads.
 *
 * This indirection keeps the base class free of static imports of its
 * subclasses. A direct import would form a module-initialization cycle (each
 * subclass statically imports the base to `extend` it), which throws at load
 * time ("Cannot access 'DuckDBVector' before initialization") regardless of
 * when `create()` is actually called. This module is intentionally not
 * re-exported from the package barrel.
 */
export const vectorRegistry: { create?: CreateDuckDBVectorFn } = {};
