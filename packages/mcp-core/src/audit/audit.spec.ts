import { describe, it, expect, vi } from 'vitest';
import { AUDIT_ACTIONS, buildAuditEntry, recordAudit, type AuditAction } from './audit.js';
import { AUDIT_ACTIONS as CANONICAL_AUDIT_ACTIONS } from '@lorekit/schemas';
import type { SupabaseClient } from '@supabase/supabase-js';

function makeInsertDb(result: { error: null | { message: string } }) {
  const insert = vi.fn().mockResolvedValue(result);
  return { from: vi.fn().mockReturnValue({ insert }), insert } as unknown as SupabaseClient & { insert: typeof insert };
}

/**
 * This block used to pin an 11-element literal list here. That list is GONE,
 * deliberately: it was one of three copies (11 here, 23 in the SQL CHECK, 24
 * in the web dashboard) that had silently drifted, and re-asserting a local
 * copy is exactly what let the drift survive. `AUDIT_ACTIONS` now comes from
 * `@lorekit/schemas` and this module only re-exports it.
 *
 * So what is asserted here is the RE-EXPORT — that `./audit.ts` still exposes
 * the same array object the canonical module does, with no filtering,
 * reordering or shadowing. The CONTENT of the list, and its agreement with the
 * SQL CHECK and the web copy, is asserted by `audit-vocabulary.spec.ts`, which
 * is a strictly stronger check than the literal this replaces.
 */
describe('AUDIT_ACTIONS', () => {
  it('is the canonical @lorekit/schemas list, re-exported unchanged', () => {
    expect(AUDIT_ACTIONS).toBe(CANONICAL_AUDIT_ACTIONS);
  });

  it('is non-empty and free of duplicates', () => {
    expect(AUDIT_ACTIONS.length).toBeGreaterThan(0);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('still contains the memory actions this module\'s own callers emit', () => {
    // Anti-vacuity for the identity assertion above: if the canonical list
    // were ever emptied or renamed wholesale, `toBe` would still pass but
    // these would not.
    for (const action of ['memory.create', 'memory.update', 'memory.archive', 'memory.restore', 'memory.delete'] as const) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
  });
});

describe('buildAuditEntry', () => {
  it('maps a minimal input (action only) to a row with all optional fields null', () => {
    expect(buildAuditEntry({ action: 'memory.create' })).toEqual({
      action: 'memory.create',
      resource_type: null,
      resource_id: null,
      target: null,
      metadata: null,
    });
  });

  it('maps every action correctly to its row shape, including resource/target/metadata', () => {
    const row = buildAuditEntry({
      action: 'api_key.create',
      resourceType: 'api_token',
      resourceId: 'token-1',
      target: 'ci-runner',
      metadata: { token_prefix: 'lk_rw_aBcD1...' },
    });
    expect(row).toEqual({
      action: 'api_key.create',
      resource_type: 'api_token',
      resource_id: 'token-1',
      target: 'ci-runner',
      metadata: { token_prefix: 'lk_rw_aBcD1...' },
    });
  });

  it('never includes a raw token/hash field — callers are responsible for what they pass, but the shape has no secret-shaped field', () => {
    const row = buildAuditEntry({ action: 'api_key.create', metadata: { token_prefix: 'lk_rw_aBcD1...' } });
    const serialised = JSON.stringify(row);
    expect(serialised).not.toMatch(/token_hash|full_token|fullToken/i);
  });

  it.each(AUDIT_ACTIONS)('accepts %s as a valid action', (action: AuditAction) => {
    expect(buildAuditEntry({ action }).action).toBe(action);
  });
});

describe('recordAudit', () => {
  it('resolves (does not throw) when the insert succeeds', async () => {
    const db = makeInsertDb({ error: null });
    await expect(recordAudit(db, { action: 'memory.create' }, 'user-1')).resolves.toBeUndefined();
  });

  it('resolves (does not throw) when the stubbed db insert rejects with a DB error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = makeInsertDb({ error: { message: 'permission denied for table audit_log' } });
    await expect(recordAudit(db, { action: 'memory.delete' }, 'user-1')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('resolves (does not throw) when the db throws synchronously (e.g. no audit_log table access at all)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const throwingDb = {
      from: vi.fn(() => {
        throw new Error('network unreachable');
      }),
    } as unknown as SupabaseClient;
    await expect(recordAudit(throwingDb, { action: 'memory.delete' }, 'user-1')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('passes user_id = null for service-role callers', async () => {
    const db = makeInsertDb({ error: null }) as unknown as SupabaseClient & {
      from: ReturnType<typeof vi.fn>;
    };
    await recordAudit(db, { action: 'memory.create' }, null);
    const insertMock = (db.from as ReturnType<typeof vi.fn>).mock.results[0].value.insert;
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ user_id: null }));
  });

  it('passes the resolved user_id through for user-attributed callers', async () => {
    const db = makeInsertDb({ error: null }) as unknown as SupabaseClient & {
      from: ReturnType<typeof vi.fn>;
    };
    await recordAudit(db, { action: 'api_key.revoke' }, 'user-42');
    const insertMock = (db.from as ReturnType<typeof vi.fn>).mock.results[0].value.insert;
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'user-42' }));
  });

  it('inserts into the audit_log table', async () => {
    const db = makeInsertDb({ error: null }) as unknown as SupabaseClient & {
      from: ReturnType<typeof vi.fn>;
    };
    await recordAudit(db, { action: 'memory.create' }, 'user-1');
    expect(db.from).toHaveBeenCalledWith('audit_log');
  });
});
