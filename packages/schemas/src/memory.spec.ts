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
  MemoryListSchema,
  MemoryWriteSchema,
  ListMemoriesQuerySchema,
  PurgeMemoriesBodySchema,
  RestoreMemoryBodySchema,
  ScopesResponseSchema,
  ReadActivityQuerySchema,
  ReadActivityBucketSchema,
  ReadActivityResponseSchema,
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

  // `?org=<slug>` switches handlers/remove.ts onto the role-gated memory_delete
  // RPC (00020) instead of a direct query. It is optional and, when absent, must
  // not appear in the parsed output at all — the handler branches on truthiness.
  it('omits org entirely when the param is absent', () => {
    expect('org' in DeleteMemoryQuerySchema.parse({ scope: 'global', key: 'k' })).toBe(false);
  });

  it('accepts the org form alongside scope+key and force', () => {
    expect(DeleteMemoryQuerySchema.parse({ scope: 'global', key: 'k', force: 'true', org: 'acme' })).toEqual({
      scope: 'global', key: 'k', force: 'true', org: 'acme',
    });
  });

  it('accepts the org form without force (soft-archive default)', () => {
    const r = DeleteMemoryQuerySchema.parse({ scope: 'global', key: 'k', org: 'acme' });
    expect(r.org).toBe('acme');
    expect(r.force).toBe('false');
  });

  // `?org=` (present but empty) would otherwise parse to '' — falsy, so the
  // handler would silently take the PERSONAL branch on a request that plainly
  // asked for the org one. Reject it instead of guessing.
  it('rejects an empty org', () => {
    expect(DeleteMemoryQuerySchema.safeParse({ scope: 'global', key: 'k', org: '' }).success).toBe(false);
  });

  it('rejects an org slug longer than the 50-char column bound', () => {
    expect(DeleteMemoryQuerySchema.safeParse({ scope: 'global', key: 'k', org: 'a'.repeat(51) }).success).toBe(false);
  });

  // The `/:id` + `org` refusal is a HANDLER concern, not a schema one: the id is
  // a path param and never reaches this schema. Documented here so the absence
  // of a schema-level rule reads as deliberate.
  it('does not itself constrain org to the scope+key form (the handler rejects /:id + org)', () => {
    expect(DeleteMemoryQuerySchema.safeParse({ org: 'acme' }).success).toBe(true);
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

describe('MemoryWriteSchema value', () => {
  it('trims surrounding whitespace from the value on write', () => {
    expect(MemoryWriteSchema.parse({ scope: 'global', key: 'k', value: '  hello  ' }).value).toBe('hello');
  });

  it('measures the byte limit against the pre-trim length (max runs before transform)', () => {
    // The .max() guard is intentionally BEFORE .transform(trim), so padding a
    // value past the limit is rejected rather than silently trimmed under it.
    const overByPadding = ' '.repeat(65_537);
    expect(MemoryWriteSchema.safeParse({ scope: 'global', key: 'k', value: overByPadding }).success).toBe(false);
  });
});

describe('ListMemoriesQuerySchema key filters', () => {
  it('accepts key_prefix as a filter distinct from exact key', () => {
    const parsed = ListMemoriesQuerySchema.parse({ key_prefix: 'debug-' });
    expect(parsed.key_prefix).toBe('debug-');
    expect(parsed.key).toBeUndefined();
  });
});

// ── GET /memories/read-activity, scope dimension (migration 00058) ──────────
describe('ReadActivityQuerySchema scope filter', () => {
  it('leaves scope undefined when the caller does not filter', () => {
    const parsed = ReadActivityQuerySchema.parse({});
    expect(parsed.scope).toBeUndefined();
    expect(parsed.bucket).toBe('day');
  });

  it('accepts an exact scope to filter by', () => {
    expect(ReadActivityQuerySchema.parse({ scope: 'repo::mthines/lorekit' }).scope)
      .toBe('repo::mthines/lorekit');
    expect(ReadActivityQuerySchema.parse({ scope: 'global' }).scope).toBe('global');
  });

  // Shape-only here BY DESIGN: `RawScopeSchema`, not `ScopeSchema`, so the
  // canonical normalisation happens once in the handler, which is the layer
  // that can turn a rejection into a 400. A schema-level transform would
  // normalise silently and leave the handler unable to distinguish "the caller
  // sent a typo" from "the caller sent it lowercase".
  it('does not normalise here — the handler owns canonicalisation and the 400', () => {
    const parsed = ReadActivityQuerySchema.parse({ scope: 'Repo::Mthines/LoreKit' });
    expect(parsed.scope).toBe('Repo::Mthines/LoreKit');
  });

  it('still rejects a structurally impossible scope value', () => {
    expect(ReadActivityQuerySchema.safeParse({ scope: '' }).success).toBe(false);
    expect(ReadActivityQuerySchema.safeParse({ scope: 42 }).success).toBe(false);
  });
});

describe('ReadActivityBucketSchema scope', () => {
  it('accepts a named scope on a bucket', () => {
    const parsed = ReadActivityBucketSchema.parse({
      bucket: '2026-04-01T00:00:00.000Z', scope: 'repo::mthines/lorekit', count: 10,
    });
    expect(parsed.scope).toBe('repo::mthines/lorekit');
  });

  // NULLABLE, unlike the write series' scope: a read may carry no scope the
  // server could resolve (body-carried or ungrammatical), and that read is
  // recorded unattributed rather than dropped — so it still reaches a client.
  it('accepts a NULL scope — unattributable reads are counted, not dropped', () => {
    const parsed = ReadActivityBucketSchema.parse({
      bucket: '2026-04-01T00:00:00.000Z', scope: null, count: 3,
    });
    expect(parsed.scope).toBeNull();
  });

  it('requires the key to be present — an absent scope is not the same as null', () => {
    expect(ReadActivityBucketSchema.safeParse({ bucket: '2026-04-01T00:00:00.000Z', count: 3 }).success)
      .toBe(false);
  });

  it('still rejects a non-integer or negative count', () => {
    const base = { bucket: '2026-04-01T00:00:00.000Z', scope: null };
    expect(ReadActivityBucketSchema.safeParse({ ...base, count: 1.5 }).success).toBe(false);
    expect(ReadActivityBucketSchema.safeParse({ ...base, count: -1 }).success).toBe(false);
  });
});

describe('ReadActivityResponseSchema', () => {
  it('accepts a response mixing named and unattributed scopes in one bucket', () => {
    const parsed = ReadActivityResponseSchema.parse({
      bucket: 'day',
      since: '2026-04-01T00:00:00.000Z',
      until: '2026-04-02T00:00:00.000Z',
      buckets: [
        { bucket: '2026-04-01T00:00:00.000Z', scope: 'repo::mthines/lorekit', count: 7 },
        { bucket: '2026-04-01T00:00:00.000Z', scope: null, count: 3 },
      ],
    });
    // The metric is additive, which is the whole reason a per-scope filter can
    // replace a companion "per-scope total" RPC: the cells sum to the headline.
    expect(parsed.buckets.reduce((n, b) => n + b.count, 0)).toBe(10);
  });
});

// ── MemoryListSchema.order (AC-2) ────────────────────────────────────────────

describe('MemoryListSchema order', () => {
  it('defaults to recency when order is omitted', () => {
    const parsed = MemoryListSchema.parse({ scope: 'global' });
    expect(parsed.order).toBe('recency');
  });

  it('accepts order: recency explicitly', () => {
    expect(MemoryListSchema.parse({ scope: 'global', order: 'recency' }).order).toBe('recency');
  });

  it('accepts order: rank', () => {
    expect(MemoryListSchema.parse({ scope: 'global', order: 'rank' }).order).toBe('rank');
  });

  it.each(['newest', 'desc', 'relevance', '', 'RANK'])('rejects an invalid order value: %j', (order) => {
    expect(MemoryListSchema.safeParse({ scope: 'global', order }).success).toBe(false);
  });

  it('does not affect other fields — limit still defaults to 50', () => {
    const parsed = MemoryListSchema.parse({ scope: 'global', order: 'rank' });
    expect(parsed.limit).toBe(50);
    expect(parsed.cursor).toBeUndefined();
    expect(parsed.tags).toBeUndefined();
  });
});
