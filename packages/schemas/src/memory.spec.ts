/**
 * Contract tests for the REST-shaped memory schemas that carry coercion or
 * defaults — the places where an HTTP request (all-strings query params, an
 * absent body field) and the validated handler input genuinely differ.
 *
 * The MCP-shaped schemas (MemoryRestoreSchema, MemoryPurgeSchema, …) are plain
 * object shapes with no coercion and are exercised through the tool specs, so
 * they are deliberately not re-tested here.
 */

import { describe, it, expect } from 'vitest';
import {
  DeleteMemoryQuerySchema,
  PurgeMemoriesBodySchema,
  RestoreMemoryBodySchema,
  ScopesResponseSchema,
  PURGE_RETENTION_DAYS_DEFAULT,
} from './memory.ts';

describe('DeleteMemoryQuerySchema', () => {
  it('defaults force to the string "false" when the param is absent', () => {
    const r = DeleteMemoryQuerySchema.parse({});
    expect(r.force).toBe('false');
    expect(r.scope).toBeUndefined();
    expect(r.key).toBeUndefined();
  });

  it('accepts the natural-key form with force=true', () => {
    expect(DeleteMemoryQuerySchema.parse({ scope: 'global', key: 'k', force: 'true' })).toEqual({
      scope: 'global', key: 'k', force: 'true',
    });
  });

  // Query params are strings; `force=1` / `force=yes` must not silently mean true.
  it.each(['1', 'yes', 'TRUE', ''])('rejects a non-enum force value: %j', (force) => {
    expect(DeleteMemoryQuerySchema.safeParse({ force }).success).toBe(false);
  });

  it('rejects an empty scope', () => {
    expect(DeleteMemoryQuerySchema.safeParse({ scope: '', key: 'k' }).success).toBe(false);
  });
});

describe('PurgeMemoriesBodySchema', () => {
  it('defaults retention_days to PURGE_RETENTION_DAYS_DEFAULT on an empty body', () => {
    expect(PurgeMemoriesBodySchema.parse({})).toEqual({ retention_days: PURGE_RETENTION_DAYS_DEFAULT });
  });

  it('coerces a numeric string (form-encoded / loosely typed clients)', () => {
    expect(PurgeMemoriesBodySchema.parse({ retention_days: '7' }).retention_days).toBe(7);
  });

  it.each([0, -1, 366, 1.5, 'abc'])('rejects out-of-range retention_days: %j', (retention_days) => {
    expect(PurgeMemoriesBodySchema.safeParse({ retention_days }).success).toBe(false);
  });

  it.each([1, 365])('accepts the inclusive bound %i', (retention_days) => {
    expect(PurgeMemoriesBodySchema.parse({ retention_days }).retention_days).toBe(retention_days);
  });
});

describe('RestoreMemoryBodySchema', () => {
  it('requires both scope and key', () => {
    expect(RestoreMemoryBodySchema.safeParse({ scope: 'global' }).success).toBe(false);
    expect(RestoreMemoryBodySchema.safeParse({ key: 'k' }).success).toBe(false);
    expect(RestoreMemoryBodySchema.parse({ scope: 'global', key: 'k' })).toEqual({ scope: 'global', key: 'k' });
  });

  // RawScopeSchema is shape-only: normalisation belongs downstream, so a
  // mixed-case scope must pass through untouched rather than be lowercased.
  it('passes a raw scope through without normalising it', () => {
    expect(RestoreMemoryBodySchema.parse({ scope: 'Repo::Acme/App', key: 'k' }).scope).toBe('Repo::Acme/App');
  });
});

describe('ScopesResponseSchema', () => {
  it('accepts the GET /memories/scopes payload', () => {
    expect(ScopesResponseSchema.parse({ scopes: [{ scope: 'global', count: 3 }] }).scopes).toHaveLength(1);
  });

  it('rejects a fractional or negative count', () => {
    expect(ScopesResponseSchema.safeParse({ scopes: [{ scope: 'global', count: 1.5 }] }).success).toBe(false);
    expect(ScopesResponseSchema.safeParse({ scopes: [{ scope: 'global', count: -1 }] }).success).toBe(false);
  });
});
