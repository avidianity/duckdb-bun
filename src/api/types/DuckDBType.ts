// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import type { DuckDBAnyType } from "./DuckDBAnyType";
import type { DuckDBArrayType } from "./DuckDBArrayType";
import type { DuckDBBigIntType } from "./DuckDBBigIntType";
import type { DuckDBBigNumType } from "./DuckDBBigNumType";
import type { DuckDBBitType } from "./DuckDBBitType";
import type { DuckDBBlobType } from "./DuckDBBlobType";
import type { DuckDBBooleanType } from "./DuckDBBooleanType";
import type { DuckDBDateType } from "./DuckDBDateType";
import type { DuckDBDecimalType } from "./DuckDBDecimalType";
import type { DuckDBDoubleType } from "./DuckDBDoubleType";
import type { DuckDBEnumType } from "./DuckDBEnumType";
import type { DuckDBFloatType } from "./DuckDBFloatType";
import type { DuckDBGeometryType } from "./DuckDBGeometryType";
import type { DuckDBHugeIntType } from "./DuckDBHugeIntType";
import type { DuckDBIntegerLiteralType } from "./DuckDBIntegerLiteralType";
import type { DuckDBIntegerType } from "./DuckDBIntegerType";
import type { DuckDBIntervalType } from "./DuckDBIntervalType";
import type { DuckDBListType } from "./DuckDBListType";
import type { DuckDBMapType } from "./DuckDBMapType";
import type { DuckDBSmallIntType } from "./DuckDBSmallIntType";
import type { DuckDBSQLNullType } from "./DuckDBSQLNullType";
import type { DuckDBStringLiteralType } from "./DuckDBStringLiteralType";
import type { DuckDBStructType } from "./DuckDBStructType";
import type { DuckDBTimeNSType } from "./DuckDBTimeNSType";
import type { DuckDBTimestampMillisecondsType } from "./DuckDBTimestampMillisecondsType";
import type { DuckDBTimestampNanosecondsType } from "./DuckDBTimestampNanosecondsType";
import type { DuckDBTimestampSecondsType } from "./DuckDBTimestampSecondsType";
import type { DuckDBTimestampType } from "./DuckDBTimestampType";
import type { DuckDBTimestampTZNanosecondsType } from "./DuckDBTimestampTZNanosecondsType";
import type { DuckDBTimestampTZType } from "./DuckDBTimestampTZType";
import type { DuckDBTimeType } from "./DuckDBTimeType";
import type { DuckDBTimeTZType } from "./DuckDBTimeTZType";
import type { DuckDBTinyIntType } from "./DuckDBTinyIntType";
import type { DuckDBUBigIntType } from "./DuckDBUBigIntType";
import type { DuckDBUHugeIntType } from "./DuckDBUHugeIntType";
import type { DuckDBUIntegerType } from "./DuckDBUIntegerType";
import type { DuckDBUnionType } from "./DuckDBUnionType";
import type { DuckDBUSmallIntType } from "./DuckDBUSmallIntType";
import type { DuckDBUTinyIntType } from "./DuckDBUTinyIntType";
import type { DuckDBUUIDType } from "./DuckDBUUIDType";
import type { DuckDBVarCharType } from "./DuckDBVarCharType";
import type { DuckDBVariantType } from "./DuckDBVariantType";

export type DuckDBType =
  | DuckDBBooleanType
  | DuckDBTinyIntType
  | DuckDBSmallIntType
  | DuckDBIntegerType
  | DuckDBBigIntType
  | DuckDBUTinyIntType
  | DuckDBUSmallIntType
  | DuckDBUIntegerType
  | DuckDBUBigIntType
  | DuckDBFloatType
  | DuckDBDoubleType
  | DuckDBTimestampType
  | DuckDBDateType
  | DuckDBTimeType
  | DuckDBIntervalType
  | DuckDBHugeIntType
  | DuckDBUHugeIntType
  | DuckDBVarCharType
  | DuckDBBlobType
  | DuckDBDecimalType
  | DuckDBTimestampSecondsType
  | DuckDBTimestampMillisecondsType
  | DuckDBTimestampNanosecondsType
  | DuckDBEnumType
  | DuckDBListType
  | DuckDBStructType
  | DuckDBMapType
  | DuckDBArrayType
  | DuckDBUUIDType
  | DuckDBUnionType
  | DuckDBBitType
  | DuckDBTimeTZType
  | DuckDBTimestampTZType
  | DuckDBAnyType
  | DuckDBBigNumType
  | DuckDBSQLNullType
  | DuckDBStringLiteralType
  | DuckDBIntegerLiteralType
  | DuckDBTimeNSType
  | DuckDBGeometryType
  | DuckDBVariantType
  | DuckDBTimestampTZNanosecondsType;
