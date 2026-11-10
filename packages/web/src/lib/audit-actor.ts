/**
 * Pure, read-time resolver for the audit-log "actor" display identity.
 *
 * The `audit_log` table (supabase/migrations/00010_audit_log.sql) is
 * append-only and stores only the opaque `user_id` — never a name, email, or
 * avatar. Its RLS policy is `user_id = auth.uid()`, so every row a viewer can
 * see belongs to that viewer: the actor is always the current session user.
 * That single fact lets us resolve the actor's display identity entirely at
 * read time from the already-loaded session user, with zero new query, join,
 * or denormalization.
 *
 * `AuditActor` is a discriminated union so a "system" actor can never carry
 * an avatar — the illegal state is unrepresentable. `resolveAuditActor` is
 * total (every input has a defined output) and pure (no throw, no I/O).
 */

import type { User } from '@supabase/supabase-js';
import { firstNonBlank, resolveDisplayName } from './display-name';

export type AuditActor =
  | { kind: 'user'; name: string; avatarUrl: string | null }
  | { kind: 'system'; name: string };

const SYSTEM_ACTOR: AuditActor = { kind: 'system', name: 'System' };

/**
 * Resolve the display actor for the current session user.
 *
 * Defensive fallback: a `null` user (unreachable in the authed dashboard,
 * since the layout redirects unauthenticated visitors) resolves to the
 * neutral `system` actor rather than a fabricated person.
 */
export function resolveAuditActor(user: User | null): AuditActor {
  if (!user) return SYSTEM_ACTOR;

  // The same name the Sidebar and Settings → User show: a chosen
  // `display_name`, then `full_name`, then the email — see `display-name.ts`.
  const name = resolveDisplayName(user);
  const avatarUrl = firstNonBlank(user.user_metadata?.['avatar_url']);

  return { kind: 'user', name, avatarUrl };
}
