// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import type { DuckDBTypeId } from "./DuckDBTypeId";
import type { DuckDBValueConverter } from "./DuckDBValueConverter";

export function createDuckDBValueConverter<T>(
  convertersByTypeId: Record<DuckDBTypeId, DuckDBValueConverter<T> | undefined>,
): DuckDBValueConverter<T> {
  return (value, type, converter) => {
    if (value == null) {
      return null;
    }
    const converterForTypeId = convertersByTypeId[type.typeId];
    if (!converterForTypeId) {
      throw new Error(`No converter for typeId: ${type.typeId}`);
    }
    return converterForTypeId(value, type, converter);
  };
}
