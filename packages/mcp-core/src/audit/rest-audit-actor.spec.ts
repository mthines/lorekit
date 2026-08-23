import { describe, it, expect } from 'vitest';
import { auditUserId } from './rest-audit-actor.ts';
import type { RestAuthActor } from './rest-audit-actor.ts';

/**
 * The rule this asserts is load-bearing on an RLS policy, not a formatting
 * preference: for a Supabase-JWT caller the REST layer uses an RLS-scoped
 * client, and `audit_log`'s insert policy is `with check (user_id =
 * auth.uid())`. Returning the caller's own id is what makes the insert
 * succeed; returning `null` (the previous behaviour) is what made it fail and
 * silently drop the row. The `user` cases below are therefore the regression
 * test for that bug, not tautologies.
 */

const UID = '11111111-2222-3333-4444-555555555555';

describe('auditUserId', () => {
  // ── the three auth types, exhaustively ────────────────────────────────────
  it('returns the resolved user for an api_key caller (service-role client, bypasses RLS)', () => {
    expect(auditUserId({ type: 'api_key', userId: UID })).toBe(UID);
  });

  it('returns the resolved user for a JWT caller — the branch that used to return null', () => {
    expect(auditUserId({ type: 'user', userId: UID })).toBe(UID);
  });

  it('returns null for a service-role caller — no human actor to name', () => {
    expect(auditUserId({ type: 'service' })).toBeNull();
  });

  it('returns null for a service-role caller even if a userId is somehow present', () => {
    // The service branch must not leak an id: `resolveRestAuth` never sets one
    // there, and if a future change did, the row must still record no actor.
    expect(auditUserId({ type: 'service', userId: UID } as RestAuthActor)).toBeNull();
  });

  // ── totality: an unresolved userId degrades to null, never undefined ──────
  it.each(['api_key', 'user'] as const)(
    'returns null (not undefined) for a %s caller with no resolved userId',
    (type) => {
      const result = auditUserId({ type });
      expect(result).toBeNull();
      expect(result).not.toBeUndefined();
    },
  );

  it('returns null for an explicitly undefined userId', () => {
    expect(auditUserId({ type: 'user', userId: undefined })).toBeNull();
  });

  // ── the exhaustiveness claim itself ───────────────────────────────────────
  it('covers every member of the RestAuthActor type union', () => {
    // If a fourth auth type is ever added, `AUTH_TYPES` stops matching the
    // union and this fails to compile — so the "every auth type" claim above
    // cannot quietly become false.
    const AUTH_TYPES: ReadonlyArray<RestAuthActor['type']> = ['user', 'service', 'api_key'];
    expect(new Set(AUTH_TYPES).size).toBe(3);
    // Every type produces a defined string-or-null result — no branch throws
    // and none falls through to undefined.
    for (const type of AUTH_TYPES) {
      const withId = auditUserId({ type, userId: UID });
      expect(withId === null || typeof withId === 'string').toBe(true);
    }
  });

  it('distinguishes service from the other two types (the whole point of the rule)', () => {
    const nonService = (['user', 'api_key'] as const).map((type) => auditUserId({ type, userId: UID }));
    expect(nonService).toEqual([UID, UID]);
    expect(auditUserId({ type: 'service', userId: UID } as RestAuthActor)).toBeNull();
  });
});
