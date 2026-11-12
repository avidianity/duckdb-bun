/** Returns `value`, or throws when it is null or undefined: a test's non-null assertion that fails with a message. */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error(`expected a value, got ${value}`);
  return value;
}
