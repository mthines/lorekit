/**
 * Canonical scope format:
 *   global
 *   project::{name}
 *   repo::{owner}/{repo}
 *   branch::{owner}/{repo}::{branch}
 *
 * The `::` double-colon is the ONLY valid segment separator.
 * Single colon, slash, or dash as separators are rejected with a validation error.
 */

import { z } from 'zod';

const VALID_PREFIXES = ['global', 'project', 'repo', 'branch'] as const;
export type ScopePrefix = (typeof VALID_PREFIXES)[number];

export class ScopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeValidationError';
  }
}

/**
 * Validate a canonical scope string. Throws ScopeValidationError if invalid.
 * Returns the normalized (lowercased) scope string.
 */
export function validateScope(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    throw new ScopeValidationError('scope must be a non-empty string');
  }

  // Reject the common mistake of using single `:` or no separator with a keyword
  if (/^(project|repo|branch):[^:]/.test(raw)) {
    throw new ScopeValidationError(
      `Invalid scope "${raw}": use "::" as the separator, not ":". ` +
        `Example: "repo::${raw.split(':')[1] ?? 'owner/repo'}"`,
    );
  }

  const normalized = raw.toLowerCase().trim();

  if (normalized === 'global') {
    return 'global';
  }

  const sepIdx = normalized.indexOf('::');
  if (sepIdx === -1) {
    throw new ScopeValidationError(
      `Invalid scope "${raw}": unknown scope type. Valid types: ${VALID_PREFIXES.join(', ')}`,
    );
  }

  const prefix = normalized.slice(0, sepIdx) as ScopePrefix;
  const rest = normalized.slice(sepIdx + 2);

  if (!VALID_PREFIXES.includes(prefix)) {
    throw new ScopeValidationError(
      `Invalid scope prefix "${prefix}". Valid prefixes: ${VALID_PREFIXES.join(', ')}`,
    );
  }

  if (!rest) {
    throw new ScopeValidationError(`Scope "${raw}" has an empty value after the prefix`);
  }

  if (prefix === 'project') {
    if (!rest.match(/^[\w.-]+$/)) {
      throw new ScopeValidationError(
        `Invalid project scope "${raw}": project name must be alphanumeric with dots and dashes`,
      );
    }
  }

  if (prefix === 'repo') {
    if (!rest.match(/^[\w.-]+\/[\w.-]+$/)) {
      throw new ScopeValidationError(
        `Invalid repo scope "${raw}": expected format "repo::owner/repo-name"`,
      );
    }
  }

  if (prefix === 'branch') {
    const parts = rest.split('::');
    if (parts.length !== 2 || !parts[0]?.match(/^[\w.-]+\/[\w.-]+$/) || !parts[1]) {
      throw new ScopeValidationError(
        `Invalid branch scope "${raw}": expected format "branch::owner/repo::branch-name"`,
      );
    }
  }

  return normalized;
}

/**
 * Return the scope type for use as a low-cardinality telemetry attribute.
 */
export function scopeType(scope: string): ScopePrefix {
  if (scope === 'global') return 'global';
  const prefix = scope.split('::')[0] as ScopePrefix;
  return prefix;
}

/**
 * Expand a search scope that may include an owner-level wildcard.
 * "repo::mthines/*" → SQL LIKE pattern "repo::mthines/%"
 * Returns { exact: string } or { like: string }.
 */
export type ScopeFilter =
  | { exact: string }
  | { like: string };

export function expandScopeForSearch(raw: string): ScopeFilter {
  const normalized = raw.toLowerCase().trim();
  // Owner wildcard: repo::owner/* or project::*
  if (normalized.endsWith('/*') || normalized.endsWith('::*')) {
    const base = normalized.endsWith('/*')
      ? normalized.slice(0, -1) // keep trailing slash, replace * with %
      : normalized.slice(0, -1); // keep ::, replace * with %
    return { like: base + '%' };
  }
  return { exact: validateScope(raw) };
}

/**
 * Zod schema for a canonical scope string (validates at the Zod layer).
 */
export const ScopeSchema = z.string().transform((val, ctx) => {
  try {
    return validateScope(val);
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
    return z.NEVER;
  }
});
