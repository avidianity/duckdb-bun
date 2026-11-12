import type { DuckDBArrayValue } from "./DuckDBArrayValue";
import type { DuckDBBitValue } from "./DuckDBBitValue";
import type { DuckDBBlobValue } from "./DuckDBBlobValue";
import type { DuckDBDateValue } from "./DuckDBDateValue";
import type { DuckDBDecimalValue } from "./DuckDBDecimalValue";
import type { DuckDBGeometryValue } from "./DuckDBGeometryValue";
import type { DuckDBIntervalValue } from "./DuckDBIntervalValue";
import type { DuckDBListValue } from "./DuckDBListValue";
import type { DuckDBMapValue } from "./DuckDBMapValue";
import type { DuckDBStructValue } from "./DuckDBStructValue";
import type { DuckDBTimeNSValue } from "./DuckDBTimeNSValue";
import type { DuckDBTimestampMillisecondsValue } from "./DuckDBTimestampMillisecondsValue";
import type { DuckDBTimestampNanosecondsValue } from "./DuckDBTimestampNanosecondsValue";
import type { DuckDBTimestampSecondsValue } from "./DuckDBTimestampSecondsValue";
import type { DuckDBTimestampTZNanosecondsValue } from "./DuckDBTimestampTZNanosecondsValue";
import type { DuckDBTimestampTZValue } from "./DuckDBTimestampTZValue";
import type { DuckDBTimestampValue } from "./DuckDBTimestampValue";
import type { DuckDBTimeTZValue } from "./DuckDBTimeTZValue";
import type { DuckDBTimeValue } from "./DuckDBTimeValue";
import type { DuckDBTupleValue } from "./DuckDBTupleValue";
import type { DuckDBUnionValue } from "./DuckDBUnionValue";
import type { DuckDBUUIDValue } from "./DuckDBUUIDValue";
import type { DuckDBVariantValue } from "./DuckDBVariantValue";

export type DuckDBValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | DuckDBArrayValue
  | DuckDBBitValue
  | DuckDBBlobValue
  | DuckDBDateValue
  | DuckDBDecimalValue
  | DuckDBGeometryValue
  | DuckDBIntervalValue
  | DuckDBListValue
  | DuckDBMapValue
  | DuckDBStructValue
  | DuckDBTimestampMillisecondsValue
  | DuckDBTimestampNanosecondsValue
  | DuckDBTimestampSecondsValue
  | DuckDBTimestampTZValue
  | DuckDBTimestampTZNanosecondsValue
  | DuckDBTimestampValue
  | DuckDBTimeTZValue
  | DuckDBTimeValue
  | DuckDBTimeNSValue
  | DuckDBTupleValue
  | DuckDBUnionValue
  | DuckDBUUIDValue
  | DuckDBVariantValue;
