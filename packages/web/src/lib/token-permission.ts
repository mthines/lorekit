/**
 * Lightweight token-permission utilities for the web package.
 * Duplicated from packages/mcp-core/src/auth/permissions.ts (the `tokenPrefixFor`
 * derivation) to avoid pulling OTel/Supabase/tool-handler code into the
 * Next.js webpack bundle — the same convention as packages/web/src/lib/scope.ts.
 * Keep in sync with the canonical implementation in mcp-core.
 */

import type { TokenPermission } from './tokens';

export type PermissionTierValue = 'rw' | 'ro' | 'wo';

/** Derive the token prefix suffix (`rw` | `ro` | `wo`) from a permission set. */
export function permissionSuffix(permissions: TokenPermission[]): PermissionTierValue {
  const hasRead = permissions.includes('read');
  const hasWrite = permissions.includes('write');
  if (hasRead && hasWrite) return 'rw';
  if (hasWrite) return 'wo';
  if (hasRead) return 'ro';
  throw new Error('permissionSuffix: permissions must include at least "read" or "write"');
}

/** Alias of permissionSuffix, named for badge/tier lookup call sites. */
export function tierFor(permissions: TokenPermission[]): PermissionTierValue {
  return permissionSuffix(permissions);
}

export interface PermissionTier {
  value: PermissionTierValue;
  label: string;
  desc: string;
  perms: TokenPermission[];
  /** CSS custom property used for card border/text and the badge accent. */
  color: string;
  /** Tailwind arbitrary-value background class (alpha tint of `color`) for the badge. */
  bg: string;
  /** Short label rendered inside the "YOUR TOKENS" badge. */
  badgeLabel: string;
}

/**
 * Single source of truth for the three permission tiers — drives both the
 * "New token" permission cards and the token-list badge so adding a tier is
 * a single edit here instead of parallel arrays.
 */
export const PERMISSION_TIERS: readonly PermissionTier[] = [
  {
    value: 'rw',
    label: 'Read + Write',
    desc: 'Agent can write and read memories',
    perms: ['read', 'write'],
    color: 'var(--color-scope-repo)',
    bg: 'bg-[#60a5fa1a]',
    badgeLabel: 'read+write',
  },
  {
    value: 'ro',
    label: 'Read only',
    desc: 'Agent can read but not write',
    perms: ['read'],
    color: 'var(--color-scope-global)',
    bg: 'bg-[#a78bfa1a]',
    badgeLabel: 'read-only',
  },
  {
    value: 'wo',
    label: 'Write only',
    desc: 'Agent can write but not read',
    perms: ['write'],
    color: 'var(--color-scope-branch)',
    bg: 'bg-[#f59e0b1a]',
    badgeLabel: 'write-only',
  },
] as const;
