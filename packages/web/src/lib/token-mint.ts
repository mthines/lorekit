import 'server-only';

/**
 * The revalidate-free core of API-token minting.
 *
 * Extracted out of `lib/tokens.ts` (a Server Actions module) so a Server
 * Component's render can mint a token without ever calling `revalidatePath`
 * during render — Next 15 throws "used revalidatePath during render which is
 * unsupported" for that, which is exactly the production bug this module
 * exists to fix: `buildOnboardingSteps({ autoGenerateToken: true })` used to
 * call the generate action in `lib/tokens.ts`, which inserted the
 * `api_tokens` row and then called `revalidatePath('/lore')` — the throw was
 * swallowed by a bare `catch {}` in `onboarding-steps.tsx`, leaving an orphan
 * row and no token on screen.
 *
 * The `server-only` import (no Server Actions directive) is deliberate: it
 * guards against a client bundle pulling this in, WITHOUT making `mintToken`
 * a client-callable action endpoint. Same pattern as `lib/key-scope-catalog.ts`.
 *
 * `lib/tokens.ts`'s `generateToken` wraps `mintToken` and adds the
 * `revalidatePath` calls — that action path is the one place in the app a
 * mint is followed by a revalidate, because it runs from a form submission,
 * not a render.
 */

import { createServerClient } from '@/lib/supabase/server';
import { getVerifiedUser } from '@/lib/auth/verified-user';
import { permissionSuffix } from '@/lib/token-permission';
import { isScoped, type OrgAccess, type TokenScoping } from '@/lib/token-scoping';
import { recordAuditEvent } from '@/lib/audit-log';
import { withSpan, logger, SpanStatusCode } from '@/lib/telemetry';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';

export type TokenPermission = 'read' | 'write';

export interface ApiToken {
  id: string;
  name: string;
  token_prefix: string;
  permissions: TokenPermission[];
  /** Scope allowlist (migration 00068). EMPTY = unrestricted. */
  scopes: string[];
  org_access: OrgAccess;
  /** Meaningful only under `org_access: 'selected'` or `'orgs_only'`. */
  org_ids: string[];
  last_used_at: string | null;
  created_at: string;
}

/** Which call site minted a token — bounded enum, safe as a span attribute. */
export type TokenMintOrigin = 'onboarding' | 'dashboard';

/**
 * The columns every read of `api_tokens` returns. Named once so a new column
 * cannot land in one query and be missed by the other — which is how
 * `listTokens` and `mintToken` would otherwise hand the UI two different
 * shapes of the same row.
 *
 * `token_hash` is deliberately absent and must stay absent: it is the stored
 * credential, and nothing in the dashboard has a use for it.
 */
export const TOKEN_COLUMNS =
  'id, name, token_prefix, permissions, scopes, org_access, org_ids, last_used_at, created_at';

/** Random alphanumeric string of given length. */
function randomAlphanumeric(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/** SHA-256 hex of a string — matches the Deno implementation in the Edge Function. */
async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MAX_TOKENS_PER_USER = 20;

/**
 * Mint a new API token. Returns the full token string ONCE — it is not
 * stored in plain text and cannot be retrieved again.
 *
 * Does NOT revalidate any path — the caller decides whether that is
 * appropriate (an action following a form submission does; a render does
 * not, because the same render already returns the fresh record).
 */
export async function mintToken(
  name: string,
  permissions: TokenPermission[],
  scoping: TokenScoping = { scopes: [], org_access: 'all', org_ids: [] },
  origin: TokenMintOrigin = 'dashboard',
): Promise<{ token: string; record: ApiToken } | { error: string }> {
  return withSpan(
    'lorekit.api_token.generate',
    {
      // permissions is a bounded set — safe as a span attribute.
      'lorekit.api_token.permissions': permissions.join(','),
      // Bounded too: the tenancy is an enum and the other two are COUNTS. The
      // scope patterns themselves are repo and project names — unbounded
      // cardinality and arguably sensitive — so they never become an attribute.
      'lorekit.api_token.org_access': scoping.org_access,
      'lorekit.api_token.scope_count': scoping.scopes.length,
      'lorekit.api_token.org_count': scoping.org_ids.length,
      // Distinguishes the render-path auto-mint from the dashboard's explicit
      // "Generate token" button in telemetry — lets prod prove this fix (first
      // sign-in mints succeed, zero `.failed`) without guessing from auth tier.
      'lorekit.api_token.origin': origin,
    },
    async (span) => {
      const supabase = await createServerClient();
      const user = await getVerifiedUser();
      if (!user) return { error: 'Not authenticated' };
      if (!name.trim()) return { error: 'Token name is required' };

      // Enforce per-user token cap
      const { count, error: countError } = await supabase
        .from('api_tokens')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id);
      if (countError) {
        span.setAttribute(ATTR_ERROR_TYPE, 'SupabaseQueryError');
        span.setStatus({ code: SpanStatusCode.ERROR, message: `SupabaseQueryError: ${countError.message}` });
        logger.error('lorekit.api_token.generate.failed', {
          'exception.type': 'SupabaseQueryError',
          'exception.message': countError.message,
        });
        return { error: countError.message };
      }
      if ((count ?? 0) >= MAX_TOKENS_PER_USER) {
        span.setAttribute('lorekit.api_token.limit_reached', true);
        return { error: `Maximum ${MAX_TOKENS_PER_USER} tokens per user. Revoke an existing token first.` };
      }

      // Build token: lk_rw_<32>, lk_ro_<32>, or lk_wo_<32>
      const permSuffix = permissionSuffix(permissions);
      const random = randomAlphanumeric(32);
      const fullToken = `lk_${permSuffix}_${random}`;
      const prefix = fullToken.slice(0, 12) + '...'; // "lk_rw_aBcD1..."
      const hash = await sha256hex(fullToken);

      const { data, error } = await supabase
        .from('api_tokens')
        .insert({
          user_id: user.id,
          name: name.trim(),
          token_prefix: prefix,
          token_hash: hash,
          permissions,
        })
        .select(TOKEN_COLUMNS)
        .single();

      if (error) {
        span.setAttribute(ATTR_ERROR_TYPE, 'SupabaseInsertError');
        span.setStatus({ code: SpanStatusCode.ERROR, message: `SupabaseInsertError: ${error.message}` });
        logger.error('lorekit.api_token.generate.failed', {
          'exception.type': 'SupabaseInsertError',
          'exception.message': error.message,
          'lorekit.api_token.permissions': permissions.join(','),
        });
        return { error: error.message };
      }

      const record = data as ApiToken;
      span.setAttribute('lorekit.api_token.id', record.id);
      span.setAttribute('lorekit.api_token.prefix', record.token_prefix);

      // Scoping is applied through the RPC rather than written into the INSERT
      // above, because the RPC is where the membership check lives: the insert
      // policy only asserts `user_id = auth.uid()`, so a hand-written
      // `org_ids` could name an org the user is not in. One gate, reused.
      //
      // A failure here DELETES the key just created. Returning it unscoped
      // would hand back a working credential that is broader than the one the
      // user asked for, and the shown-once banner would tell them it is
      // narrowed — the single worst outcome available on this path. Better no
      // key and a legible error.
      if (isScoped(scoping)) {
        const applied = await applyScoping(supabase, record.id, scoping);
        if ('error' in applied) {
          // The cleanup's own error is NOT discarded. If the DELETE fails the
          // very outcome the comment above calls the worst available has
          // happened anyway — a live UNSCOPED key exists while the caller is
          // told the operation failed — so the caller is told which of the two
          // situations they are in, and the prefix is named so they can revoke
          // it. Swallowing it would leave the credential invisible.
          const { error: cleanupError } = await supabase
            .from('api_tokens')
            .delete()
            .eq('id', record.id)
            .eq('user_id', user.id);
          span.setAttribute(ATTR_ERROR_TYPE, 'ScopingRejected');
          span.setAttribute('lorekit.api_token.cleanup_failed', cleanupError != null);
          span.setStatus({ code: SpanStatusCode.ERROR, message: `ScopingRejected: ${applied.error}` });
          logger.error('lorekit.api_token.generate.failed', {
            'exception.type': 'ScopingRejected',
            'exception.message': applied.error,
            ...(cleanupError
              ? {
                  'lorekit.api_token.cleanup_error': cleanupError.message,
                  'lorekit.api_token.prefix': record.token_prefix,
                }
              : {}),
          });
          if (cleanupError) {
            return {
              error:
                `${applied.error} An UNSCOPED token (${record.token_prefix}) could not be removed ` +
                `afterwards (${cleanupError.message}) — revoke it below.`,
            };
          }
          return { error: applied.error };
        }
        record.scopes = applied.scoping.scopes;
        record.org_access = applied.scoping.org_access;
        record.org_ids = applied.scoping.org_ids;
      }

      // Audit metadata is limited to the name + prefix — NEVER the raw token or
      // its hash, so the trail can never leak a usable credential.
      await recordAuditEvent({
        action: 'api_key.create',
        resourceType: 'api_token',
        resourceId: record.id,
        target: record.name,
        metadata: {
          name: record.name,
          token_prefix: record.token_prefix,
          // The scoping the key was BORN with, so the trail answers "what could
          // this key reach when it was issued?" without joining to a later
          // scope_change event.
          scopes: record.scopes,
          org_access: record.org_access,
          org_ids: record.org_ids,
        },
      });

      return { token: fullToken, record };
    },
  );
}

/**
 * Call `lorekit_api_token_set_scoping` and normalise its two failure shapes.
 *
 * The RPC raises with a `LKnnn:` prefix that is meaningful to the API and noise
 * to a person reading a form, so the known codes are translated and anything
 * else falls through verbatim rather than being flattened into a generic
 * "something went wrong" — an unrecognised database error is exactly when the
 * raw text is worth having.
 *
 * Exported so `lib/tokens.ts`'s `setTokenScoping` action can reuse the same
 * translation rather than duplicating it.
 */
export async function applyScoping(
  supabase: Awaited<ReturnType<typeof createServerClient>>,
  tokenId: string,
  scoping: TokenScoping,
): Promise<{ scoping: TokenScoping } | { error: string }> {
  const { data, error } = await supabase.rpc('lorekit_api_token_set_scoping', {
    p_token_id: tokenId,
    p_scopes: scoping.scopes,
    p_org_access: scoping.org_access,
    p_org_ids: scoping.org_ids,
  });

  if (error) return { error: translateScopingError(error.message) };

  // `RETURNS TABLE` resolves to an array. An empty one means the UPDATE matched
  // nothing, which the RPC should have raised on — treat it as a failure rather
  // than reporting a save that did not happen.
  const row = (data as { scopes: string[]; org_access: OrgAccess; org_ids: string[] }[] | null)?.[0];
  if (!row) return { error: 'Could not update this key. It may have been revoked.' };

  return {
    scoping: {
      scopes: row.scopes ?? [],
      org_access: row.org_access ?? 'all',
      org_ids: row.org_ids ?? [],
    },
  };
}

/** Map the RPC's `LKnnn:` codes onto something worth showing under a form field. */
function translateScopingError(message: string): string {
  if (message.includes('LK003')) return 'Could not update this key. It may have been revoked.';
  if (message.includes('LK002')) return 'You are not a member of one of the selected organisations.';
  if (message.includes('LK004')) {
    // The RPC's own text after the code is already written for a person — it
    // names the offending rule ("at most 50 scope patterns per key") — so pass
    // it through rather than replacing it with something vaguer.
    return message.slice(message.indexOf('LK004:') + 'LK004:'.length).trim();
  }
  return message;
}
