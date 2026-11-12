// Derived from duckdb-node-neo v2.0.0-r.1 (https://github.com/duckdb/duckdb-node-neo).
// Copyright 2018-2025 Stichting DuckDB Foundation. MIT License; src/api/LICENSE holds the notice.

import { createDuckDBValueConverter } from "./createDuckDBValueConverter";
import { DuckDBTypeId } from "./DuckDBTypeId";
import type { DuckDBValueConverterFor } from "./DuckDBValueConverter";
import {
  arrayFromArrayValue,
  arrayFromListValue,
  bigintFromBigIntValue,
  bigintFromTimeNSValue,
  bigintFromTimeValue,
  booleanFromValue,
  bytesFromBitValue,
  bytesFromBlobValue,
  bytesFromGeometryValue,
  dateFromDateValue,
  dateFromTimestampMillisecondsValue,
  dateFromTimestampNanosecondsValue,
  dateFromTimestampSecondsValue,
  dateFromTimestampTZNanosecondsValue,
  dateFromTimestampTZValue,
  dateFromTimestampValue,
  doubleFromDecimalValue,
  fromVariantValue,
  nullConverter,
  numberFromValue,
  objectArrayFromMapValue,
  objectFromIntervalValue,
  objectFromTimeTZValue,
  objectFromUnionValue,
  objectOrArrayFromStructValue,
  stringFromValue,
  unsupportedConverter,
} from "./DuckDBValueConverters";
import type { JS } from "./JS";
import type { JSTypeForTypeId } from "./JSTypeForTypeId";

const JSConvertersByTypeId: {
  [Id in DuckDBTypeId]: DuckDBValueConverterFor<JSTypeForTypeId[Id], JS>;
} = {
  [DuckDBTypeId.INVALID]: unsupportedConverter,
  [DuckDBTypeId.BOOLEAN]: booleanFromValue,
  [DuckDBTypeId.TINYINT]: numberFromValue,
  [DuckDBTypeId.SMALLINT]: numberFromValue,
  [DuckDBTypeId.INTEGER]: numberFromValue,
  [DuckDBTypeId.BIGINT]: bigintFromBigIntValue,
  [DuckDBTypeId.UTINYINT]: numberFromValue,
  [DuckDBTypeId.USMALLINT]: numberFromValue,
  [DuckDBTypeId.UINTEGER]: numberFromValue,
  [DuckDBTypeId.UBIGINT]: bigintFromBigIntValue,
  [DuckDBTypeId.FLOAT]: numberFromValue,
  [DuckDBTypeId.DOUBLE]: numberFromValue,
  [DuckDBTypeId.TIMESTAMP]: dateFromTimestampValue,
  [DuckDBTypeId.DATE]: dateFromDateValue,
  [DuckDBTypeId.TIME]: bigintFromTimeValue,
  [DuckDBTypeId.INTERVAL]: objectFromIntervalValue,
  [DuckDBTypeId.HUGEINT]: bigintFromBigIntValue,
  [DuckDBTypeId.UHUGEINT]: bigintFromBigIntValue,
  [DuckDBTypeId.VARCHAR]: stringFromValue,
  [DuckDBTypeId.BLOB]: bytesFromBlobValue,
  [DuckDBTypeId.DECIMAL]: doubleFromDecimalValue,
  [DuckDBTypeId.TIMESTAMP_S]: dateFromTimestampSecondsValue,
  [DuckDBTypeId.TIMESTAMP_MS]: dateFromTimestampMillisecondsValue,
  [DuckDBTypeId.TIMESTAMP_NS]: dateFromTimestampNanosecondsValue,
  [DuckDBTypeId.ENUM]: stringFromValue,
  [DuckDBTypeId.LIST]: arrayFromListValue,
  [DuckDBTypeId.STRUCT]: objectOrArrayFromStructValue,
  [DuckDBTypeId.MAP]: objectArrayFromMapValue,
  [DuckDBTypeId.ARRAY]: arrayFromArrayValue,
  [DuckDBTypeId.UUID]: stringFromValue,
  [DuckDBTypeId.UNION]: objectFromUnionValue,
  [DuckDBTypeId.BIT]: bytesFromBitValue,
  [DuckDBTypeId.TIME_TZ]: objectFromTimeTZValue,
  [DuckDBTypeId.TIMESTAMP_TZ]: dateFromTimestampTZValue,
  [DuckDBTypeId.ANY]: unsupportedConverter,
  [DuckDBTypeId.BIGNUM]: bigintFromBigIntValue,
  [DuckDBTypeId.SQLNULL]: nullConverter,
  [DuckDBTypeId.STRING_LITERAL]: unsupportedConverter,
  [DuckDBTypeId.INTEGER_LITERAL]: unsupportedConverter,
  [DuckDBTypeId.TIME_NS]: bigintFromTimeNSValue,
  [DuckDBTypeId.GEOMETRY]: bytesFromGeometryValue,
  [DuckDBTypeId.VARIANT]: fromVariantValue,
  [DuckDBTypeId.TIMESTAMP_TZ_NS]: dateFromTimestampTZNanosecondsValue,
};

export const JSDuckDBValueConverter = createDuckDBValueConverter<JS>(JSConvertersByTypeId);
