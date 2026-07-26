/**
 * Opaque keyset-cursor codec — pure, audit-decoupled.
 *
 * The cursor carries the `(created_at, id)` position a keyset page left off
 * at. It intentionally carries NO `user_id`: every caller (e.g.
 * `listAuditLog`) applies its own RLS-equivalent `.eq('user_id', …)`
 * unconditionally, so a forged/tampered cursor can at worst mis-page the
 * caller's OWN rows — it can never widen visibility or leak another user's
 * data. That's what makes `decodeCursor` safe to fail closed to `null`
 * (treated as "first page") instead of needing an HMAC/signature.
 */

export interface KeysetCursor {
  /** `created_at`, ISO timestamp string. */
  c: string;
  /** Tiebreaker id (uuid) for rows sharing the same `created_at`. */
  id: string;
}

/** Encode a cursor as an opaque base64url string. */
export function encodeCursor(cur: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cur), 'utf-8').toString('base64url');
}

/**
 * Decode an opaque cursor string. Returns `null` for anything malformed,
 * forged, truncated, or otherwise not a well-shaped `{ c, id }` pair —
 * never throws.
 */
export function decodeCursor(raw: string | null | undefined): KeysetCursor | null {
  if (!raw) return null;

  let json: string;
  try {
    json = Buffer.from(raw, 'base64url').toString('utf-8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).c !== 'string' ||
    typeof (parsed as Record<string, unknown>).id !== 'string'
  ) {
    return null;
  }

  const { c, id } = parsed as { c: string; id: string };
  if (!c || !id) return null;

  return { c, id };
}
