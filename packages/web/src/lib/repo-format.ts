/**
 * Pure validator for a bare `owner/name` GitHub repository identifier, used
 * for per-repo webhook secrets. Aligned with the `repo::owner/name` segment
 * rules in packages/mcp-core/src/scope.ts (single source of truth for what
 * a valid owner/name looks like), but exposed as a standalone function since
 * no bare (non-scope-prefixed) validator existed.
 */

const REPO_FORMAT = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;

/**
 * Normalize and validate a repo identifier.
 *
 * Trims whitespace, lowercases, and checks it matches `owner/name` (exactly
 * one slash, two non-empty segments of letters/digits/dots/underscores/
 * dashes). Returns the normalized string, or `null` if invalid.
 */
export function normalizeRepo(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || !REPO_FORMAT.test(trimmed)) return null;
  return trimmed;
}
