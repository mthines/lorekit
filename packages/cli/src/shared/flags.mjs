// Shared CLI flag-value parsers. Zero-dependency, following the package convention.

/**
 * Parse an optional non-negative-integer flag value.
 *
 * Returns `{ value: undefined }` when the flag was omitted, `{ value: N }` on a
 * valid whole number, or `{ error }` naming the flag on anything else — never
 * coerces a half-understood value (`12abc`, `1.5`) into a number silently.
 */
export function parseIntFlag(raw, name) {
  if (raw === undefined) return { value: undefined };
  if (!/^\d+$/.test(String(raw).trim())) {
    return { error: `--${name} must be a whole number, got ${JSON.stringify(String(raw))}` };
  }
  return { value: Number(String(raw).trim()) };
}
