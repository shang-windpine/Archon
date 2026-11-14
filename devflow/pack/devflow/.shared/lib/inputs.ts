/**
 * Reading what the engine binds to a script, beyond the text `input()` returns.
 *
 * A `with:` binding is always text: a skipped producer bound with `if_skipped: null`
 * arrives as `null`, and a field its producer declared null arrives as empty text.
 * What a value means belongs to the script that knows what it is for.
 */

/** A bound JSON value that may be null: empty text and a literal `null` both read as null. */
export function nullableJson(bound: string | undefined): unknown {
  const raw = (bound ?? '').trim();
  return raw === '' ? null : (JSON.parse(raw) as unknown);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as an object, or undefined for anything else, an array included. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}
