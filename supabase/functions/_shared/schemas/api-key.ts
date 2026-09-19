// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/domain/api-key.ts
// Regenerate: node scripts/codegen/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
import { z } from 'npm:zod@3';

/**
 * API key scoping — the wire contract for narrowing what a `lk_*` token reaches.
 *
 * A key used to inherit the entire visibility of its owning user: every personal
 * memory plus every org they belong to. Scoping adds two axes on top of the
 * read/write one the token prefix already encodes:
 *
 *   • `scopes`     — an allowlist of scope patterns. EMPTY MEANS UNRESTRICTED.
 *   • `orgAccess`  — the tenancy: `all` | `personal` | `selected`, with
 *                    `orgIds` meaningful only under `selected`.
 *
 * Kept in `@lorekit/schemas` rather than next to the dashboard's server actions
 * because the same shape is read by the edge auth path and, once the management
 * surface exists, written over REST — one definition, mirrored into
 * `supabase/functions/_shared/schemas/` like every other domain file.
 *
 * The authority is the DB (migration 00068): these schemas mirror its CHECKs so
 * a bad value is rejected at the edge with a readable message instead of coming
 * back as a constraint-violation string, but they never replace the constraint.
 */

/** Mirrors `api_tokens_scopes_len` / `api_tokens_org_ids_len`. */
export const API_KEY_MAX_SCOPES = 50;
export const API_KEY_MAX_ORGS = 50;

/**
 * The charset a scope pattern may use, plus an optional segment wildcard: a
 * trailing `*` directly after a `/` or a `::`.
 *
 * Byte-identical to `expandScopeForSearch`'s PostgREST injection guard, because
 * an allowlisted pattern ends up in the same kind of predicate as a searched
 * one — and its wildcard POSITION matches too: a trailing `*` counts only after
 * `/` or `::`. "Any trailing star" would let `repo::mthines/lore*` allowlist
 * `repo::mthines/lorekit-private` while being refused as a search filter.
 *
 * Shape-only on purpose: `repo::mthines/*` is a legal pattern and is NOT a legal
 * scope, so `ScopeSchema` cannot be reused here.
 */
const SCOPE_PATTERN = /^[a-z0-9._:/-]+(?:(?:\/|::)\*)?$/;

/** One entry of a key's scope allowlist: a canonical scope, or an owner wildcard. */
export const ApiKeyScopePatternSchema = z
  .string()
  .min(1, 'a scope pattern must be a non-empty string')
  .max(200, 'a scope pattern must be at most 200 characters')
  .transform((val) => val.toLowerCase().trim())
  .refine((val) => SCOPE_PATTERN.test(val), {
    message:
      'a scope pattern may contain only [a-z0-9._:/-], with an optional trailing "*" ' +
      'directly after a "/" or a "::" (e.g. "repo::mthines/lorekit", ' +
      '"repo::mthines/*" or "project::*"; "repo::mthines/lore*" is not a pattern)',
  });

/**
 * The allowlist itself. An empty array is the DEFAULT and means unrestricted —
 * see migration 00068 decision 1. It is not a validation failure, and a caller
 * clearing the list is deliberately how a key is un-scoped again.
 */
export const ApiKeyScopesSchema = z
  .array(ApiKeyScopePatternSchema)
  .max(API_KEY_MAX_SCOPES, `at most ${API_KEY_MAX_SCOPES} scope patterns per key`)
  .default([]);

export const API_KEY_ORG_ACCESS = ['all', 'personal', 'selected'] as const;

/**
 * Which tenancy a key reaches.
 *
 * A tri-state rather than "an empty `orgIds` means everything": empty would
 * have to mean both "unrestricted" and "no orgs at all", and those are the two
 * most different answers available.
 */
export const ApiKeyOrgAccessSchema = z.enum(API_KEY_ORG_ACCESS);

export type ApiKeyOrgAccess = z.infer<typeof ApiKeyOrgAccessSchema>;

/**
 * A key's full scoping, with the cross-field rule the DB also enforces
 * (`api_tokens_org_ids_match_access`).
 *
 * The `superRefine` states it in both directions on purpose. Only checking
 * "selected ⇒ non-empty" would let `personal` carry a list of orgs — a row that
 * reads as granted access and is not, which is the worst failure mode an
 * authorization record has.
 */
export const ApiKeyScopingSchema = z
  .object({
    scopes: ApiKeyScopesSchema,
    orgAccess: ApiKeyOrgAccessSchema.default('all'),
    orgIds: z
      .array(z.string().uuid('org id must be a uuid'))
      .max(API_KEY_MAX_ORGS, `at most ${API_KEY_MAX_ORGS} orgs per key`)
      .default([]),
  })
  .superRefine((val, ctx) => {
    if (val.orgAccess === 'selected' && val.orgIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orgIds'],
        message: 'orgAccess "selected" requires at least one org id',
      });
    }
    if (val.orgAccess !== 'selected' && val.orgIds.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orgIds'],
        message: `orgAccess "${val.orgAccess}" must not carry org ids`,
      });
    }
  });

export type ApiKeyScoping = z.infer<typeof ApiKeyScopingSchema>;

/** The unrestricted default — what every key created before 00068 has. */
export const UNSCOPED_API_KEY: ApiKeyScoping = {
  scopes: [],
  orgAccess: 'all',
  orgIds: [],
};

/**
 * Does a key with this allowlist reach `scope`?
 *
 * The TypeScript twin of `lorekit_api_token_scope_allowed` (00068). Both exist
 * because the write path's last unbypassable gate is inside `memory_write`,
 * which cannot call TypeScript, while the transports want to refuse early
 * without a round trip. They must agree — the SQL is the authority, and
 * `api-key.spec.ts` pins the cases that would let them drift.
 *
 * A `null` scope is an operation that carries none (`memory.purge_expired`, the
 * account-wide reads). Refusing it is the fail-closed answer: a key narrowed to
 * one repo has no business sweeping the account.
 *
 * A pattern is only treated as a wildcard when it satisfies `SCOPE_PATTERN`
 * above — the authority this module owns — which puts `*` directly after `/` or
 * `::` and nowhere else. A stored `repo::mthines/lore*` is malformed, and
 * honouring it as a `repo::mthines/lore` prefix would WIDEN the key to every
 * repo starting with those letters. A non-conforming pattern therefore matches
 * only itself, which can only narrow. `keyScopeFilter` drops such a pattern and
 * `lorekit_api_token_scope_allowed` skips it; all three agree that it never
 * expands.
 */
export function scopeAllowedByKey(patterns: readonly string[], scope: string | null): boolean {
  if (patterns.length === 0) return true;
  if (scope === null) return false;
  return patterns.some((pattern) => {
    if (!pattern.endsWith('*') || !SCOPE_PATTERN.test(pattern)) return scope === pattern;
    return scope.startsWith(pattern.slice(0, -1));
  });
}

/**
 * Does a key with this tenancy reach a row owned by `orgId` (`null` = personal)?
 *
 * The TypeScript twin of `lorekit_api_token_org_allowed` (00068). A personal row
 * is reachable under every tenancy: `personal` narrows which ORGS are reachable,
 * it never revokes the owner's own memories.
 */
export function orgAllowedByKey(
  orgAccess: ApiKeyOrgAccess,
  orgIds: readonly string[],
  orgId: string | null,
): boolean {
  if (orgId === null) return true;
  if (orgAccess === 'all') return true;
  if (orgAccess === 'selected') return orgIds.includes(orgId);
  // `personal`, and anything else. Written as an explicit fall-through rather
  // than `orgAccess === 'personal' ? false : orgIds.includes(orgId)` so an
  // unrecognised value denies instead of being treated as `selected` — the SQL
  // twin has the same `else false`, and §81 AC-3 asserts it.
  return false;
}

/**
 * Narrow `rows` to the ones this key's scope allowlist reaches.
 *
 * The read-side counterpart to `scopeAllowedByKey`'s refusal: a LIST of rows
 * (each carrying its own `scope`) has nothing to name-and-refuse against, so
 * the honest answer is to drop the ones outside the allowlist rather than
 * error the whole call — exactly how `applyTenantScope`/`applyRestTenantScope`
 * narrow a memories query instead of refusing it. `policy.list` is the first
 * caller: a scope-restricted key must never see a fenced-scope policy, saved
 * or not.
 *
 * An empty allowlist (unrestricted key) is a no-op, matching
 * `scopeAllowedByKey([], …) === true` for every row.
 */
export function narrowByKeyScope<T extends { scope: string }>(
  patterns: readonly string[],
  rows: readonly T[],
): T[] {
  if (patterns.length === 0) return [...rows];
  return rows.filter((row) => scopeAllowedByKey(patterns, row.scope));
}

/**
 * The canonical message for a scope outside a key's allowlist.
 *
 * Byte-identical to the wording the MCP dispatcher's pre-dispatch memory gate
 * already uses (`mcp-handler.ts`'s early refusal) — colocating it here lets a
 * new caller (the retention/groom gate) phrase the SAME denial instead of
 * drifting to a second wording, per the "one canonical denial message"
 * decision.
 */
export function keyScopeDeniedMessage(scope: string): string {
  return (
    `This token is not allowed to use the scope "${scope}". `
    + 'It is restricted to specific scopes — widen it in the dashboard under Settings → API keys.'
  );
}

/**
 * Thrown when the RESOLVED scope of an operation falls outside the calling
 * key's allowlist.
 *
 * Introduced for the retention/groom gate (`policy.*`/`groom.*`), whose scope
 * is not always known until after a DB round trip (`policy.update`/`delete`
 * gate the STORED scope; `groom.*` gate the scope a `policy_id` resolves to) —
 * unlike the memory family's early, pre-dispatch refusal, this is thrown from
 * INSIDE a handler, so it needs a distinct type the caller can catch and map,
 * rather than a bespoke early `return`.
 *
 * Deliberately NOT one of the transports' generic "client error" classes: it
 * must map to an authenticated-but-forbidden response (MCP `JSONRPC_FORBIDDEN`,
 * REST `403`), never the in-band `isError` shape a tool-originated failure
 * gets on MCP — see `mcp-authz-status.spec.ts` and the plan's error-shape-parity
 * risk note. Kept OUT of any `isClientError` set for that reason.
 */
export class KeyScopeDeniedError extends Error {
  constructor(public readonly scope: string) {
    super(keyScopeDeniedMessage(scope));
    this.name = 'KeyScopeDeniedError';
  }
}

/**
 * Is this key restricted at all?
 *
 * Still spec-only, and NOT because the management surface is pending — it
 * shipped. The dashboard answers the same question over its OWN type:
 * `token-scoping.ts`'s `isScoped` reads a `TokenScoping`, whose fields are the
 * database's snake_case (`org_access`, `org_ids`) because it is built straight
 * from an `api_tokens` row, where this one reads the camelCase `ApiKeyScoping`
 * the transports parse. Converting at the boundary just to share a two-clause
 * predicate would buy nothing and add a shape to keep in step.
 *
 * So the caller this is waiting for is a TRANSPORT-side one — the OTel
 * attribute that marks a request as made by a restricted key — and until that
 * lands the only caller is `api-key.spec.ts`.
 */
export function isScopedKey(scoping: ApiKeyScoping): boolean {
  return scoping.scopes.length > 0 || scoping.orgAccess !== 'all';
}
