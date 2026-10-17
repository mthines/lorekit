'use server';

/**
 * Server actions for API token management.
 * All actions validate the user session before operating.
 *
 * Minting itself lives in `lib/token-mint.ts` (a `server-only`, non-action
 * module) so a Server Component's render can mint a token without this
 * file's `revalidatePath` calls running during render — see that module's
 * header for the production bug this split fixes. `generateToken` below is
 * the action path: mint, then revalidate on success only.
 */

import { createServerClient } from '@/lib/supabase/server';
import { getVerifiedUser } from '@/lib/auth/verified-user';
import { revalidatePath } from 'next/cache';
import { recordAuditEvent } from '@/lib/audit-log';
import { withSpan, logger, SpanStatusCode } from '@/lib/telemetry';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import { mintToken, applyScoping, TOKEN_COLUMNS, type ApiToken, type TokenPermission } from '@/lib/token-mint';
import type { TokenScoping } from '@/lib/token-scoping';

export type { ApiToken, TokenPermission };

/**
 * Generate a new API token. Returns the full token string ONCE — it is not
 * stored in plain text and cannot be retrieved again.
 *
 * Thin wrapper over `mintToken` (origin `'dashboard'`): revalidates `/lore`
 * and the `/settings` layout on success, and only on success — this action
 * runs from a form submission (`TokenManager`), never from a render.
 */
export async function generateToken(
  name: string,
  permissions: TokenPermission[],
  scoping: TokenScoping = { scopes: [], org_access: 'all', org_ids: [] },
): Promise<{ token: string; record: ApiToken } | { error: string }> {
  const result = await mintToken(name, permissions, scoping, 'dashboard');
  if ('token' in result) {
    revalidatePath('/lore');
    // 'layout' so nested /settings/* pages (where tokens actually render) revalidate,
    // not just the /settings redirect page.
    revalidatePath('/settings', 'layout');
  }
  return result;
}

/** List all tokens for the current user. Returns [] on auth failure or DB error. */
export async function listTokens(): Promise<ApiToken[]> {
  const supabase = await createServerClient();
  const user = await getVerifiedUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('api_tokens')
    .select(TOKEN_COLUMNS)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('lorekit.api_token.list.failed', {
      'exception.type': 'SupabaseQueryError',
      'exception.message': error.message,
    });
    return [];
  }
  return (data ?? []) as ApiToken[];
}

/** Revoke (delete) a token by ID. */
export async function revokeToken(tokenId: string): Promise<{ error?: string }> {
  return withSpan(
    'lorekit.api_token.revoke',
    { 'lorekit.api_token.id': tokenId },
    async (span) => {
      const supabase = await createServerClient();
      const user = await getVerifiedUser();
      if (!user) return { error: 'Not authenticated' };

      // Fetch name + prefix before the delete so the audit event has a
      // human-readable target — the row is gone by the time we'd otherwise ask.
      const { data: existing, error: preReadError } = await supabase
        .from('api_tokens')
        .select('name, token_prefix')
        .eq('id', tokenId)
        .eq('user_id', user.id)
        .maybeSingle();

      // `count: 'exact'` is what makes the audit below honest. Without it the
      // delete reports success for a filter that matched NOTHING — a stale tab,
      // a double-click, an id already revoked — and an unconditional audit
      // write would record a revocation that never happened. The row count is
      // the positive signal that the operation landed; the pre-read above is
      // not (it only says whether we could READ the row).
      const { error, count } = await supabase
        .from('api_tokens')
        .delete({ count: 'exact' })
        .eq('id', tokenId)
        .eq('user_id', user.id); // Ensure ownership

      if (error) {
        span.setAttribute(ATTR_ERROR_TYPE, 'SupabaseDeleteError');
        span.setStatus({ code: SpanStatusCode.ERROR, message: `SupabaseDeleteError: ${error.message}` });
        logger.error('lorekit.api_token.revoke.failed', {
          'exception.type': 'SupabaseDeleteError',
          'exception.message': error.message,
          'lorekit.api_token.id': tokenId,
        });
        return { error: error.message };
      }

      // Nothing matched: the key was already gone. Idempotent for the caller —
      // the desired state holds — but there is no revocation to audit. Recorded
      // on the span so a no-op is observable rather than silently indistinguishable
      // from a real revoke.
      if (count === 0) {
        span.setAttribute('lorekit.api_token.revoke.no_op', true);
        revalidatePath('/lore');
        revalidatePath('/settings', 'layout');
        return {};
      }

      // A row DID go. From here the audit event is unconditional: the pre-read
      // is a decoration — it makes the target human-readable — and a transient
      // failure on it must not turn a revocation that landed into a silent gap
      // in the trail. `resourceId` identifies the key either way.
      if (existing) {
        span.setAttribute('lorekit.api_token.prefix', (existing.token_prefix as string) ?? '');
      }
      await recordAuditEvent({
        action: 'api_key.revoke',
        resourceType: 'api_token',
        resourceId: tokenId,
        target: (existing?.name as string) ?? tokenId,
        metadata: existing
          ? { name: existing.name, token_prefix: existing.token_prefix }
          : { name: null, token_prefix: null, pre_read_unavailable: preReadError?.message ?? 'not_found' },
      });

      revalidatePath('/lore');
      revalidatePath('/settings', 'layout');
      return {};
    },
  );
}

/**
 * Point an existing key at a set of scopes and a tenancy.
 *
 * Everything about WHO may do this lives in `lorekit_api_token_set_scoping`
 * (migration 00068): ownership, the org-membership check, and the cross-field
 * rule between `org_access` and `org_ids`. This action does not re-derive any
 * of it — it calls the one gate (via `token-mint.ts`'s `applyScoping`) and
 * translates the refusal.
 *
 * Clearing is the same call with an unrestricted argument; there is no separate
 * "unscope" action, for the same reason the audit vocabulary has one term.
 */
export async function setTokenScoping(
  tokenId: string,
  scoping: TokenScoping,
): Promise<{ scoping: TokenScoping } | { error: string }> {
  return withSpan(
    'lorekit.api_token.set_scoping',
    {
      'lorekit.api_token.id': tokenId,
      'lorekit.api_token.org_access': scoping.org_access,
      'lorekit.api_token.scope_count': scoping.scopes.length,
      'lorekit.api_token.org_count': scoping.org_ids.length,
    },
    async (span) => {
      const supabase = await createServerClient();
      const user = await getVerifiedUser();
      if (!user) return { error: 'Not authenticated' };

      // Read the name BEFORE the change so the audit target is human-readable,
      // and the previous scoping so the trail records a transition rather than
      // just a destination — "narrowed to one repo" is the interesting event,
      // and it is unreadable without the "from".
      const { data: existing, error: preReadError } = await supabase
        .from('api_tokens')
        .select('name, scopes, org_access, org_ids')
        .eq('id', tokenId)
        .eq('user_id', user.id)
        .maybeSingle();

      const applied = await applyScoping(supabase, tokenId, scoping);
      if ('error' in applied) {
        span.setAttribute(ATTR_ERROR_TYPE, 'ScopingRejected');
        span.setStatus({ code: SpanStatusCode.ERROR, message: `ScopingRejected: ${applied.error}` });
        logger.error('lorekit.api_token.set_scoping.failed', {
          'exception.type': 'ScopingRejected',
          'exception.message': applied.error,
          'lorekit.api_token.id': tokenId,
        });
        return { error: applied.error };
      }

      // Unconditional: the change has LANDED by this point, so skipping the
      // event when the pre-read failed would leave exactly the silent hole in
      // the authorization trail that 00070 exists to close. A missing `from` is
      // a degraded record; a missing ROW is no record at all, and only one of
      // those is recoverable by a reader.
      await recordAuditEvent({
        action: 'api_key.scope_change',
        resourceType: 'api_token',
        resourceId: tokenId,
        target: (existing?.name as string) ?? tokenId,
        metadata: {
          name: existing?.name ?? null,
          from: existing
            ? {
                scopes: existing.scopes ?? [],
                org_access: existing.org_access ?? 'all',
                org_ids: existing.org_ids ?? [],
              }
            : null,
          // Present only on the degraded path, so a reader can tell "the key
          // was unscoped before" from "we could not find out".
          ...(existing ? {} : { from_unavailable: preReadError?.message ?? 'not_found' }),
          to: applied.scoping,
        },
      });

      revalidatePath('/lore');
      revalidatePath('/settings', 'layout');
      return { scoping: applied.scoping };
    },
  );
}
