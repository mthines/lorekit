/**
 * Pure validator/normalizer for an org slug — the human-readable identifier
 * used in `createOrg`/`lorekit_org_create` and displayed in org URLs. Mirrors
 * `repo-format.ts`'s `normalizeRepo` shape (trim, lowercase, regex-validate,
 * return `string | null`), but validates a single segment (no `owner/name`
 * split) with explicit length bounds instead.
 *
 * The `orgs.slug` column itself also CHECKs `slug = lower(slug)`
 * (00012_orgs.sql) — this normalizer is what keeps a caller from ever hitting
 * that CHECK violation with an otherwise-valid slug that just needs
 * lowercasing.
 */

const SLUG_FORMAT = /^[a-z0-9-]+$/;
const MIN_LENGTH = 2;
const MAX_LENGTH = 48;

/**
 * Normalize and validate an org slug.
 *
 * Trims whitespace, lowercases, and checks it matches `^[a-z0-9-]+$` within
 * `[2, 48]` characters. Returns the normalized string, or `null` if invalid
 * or empty.
 */
export function normalizeSlug(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.length < MIN_LENGTH || trimmed.length > MAX_LENGTH) return null;
  if (!SLUG_FORMAT.test(trimmed)) return null;
  return trimmed;
}
