import { describe, it, expect } from 'vitest';
import type { MemoryEntry } from '@lorekit/schemas/memory';
import { lessonFromMemoryEntry } from './lesson-entry';

const base: MemoryEntry = {
  id: '11111111-1111-4111-8111-111111111111',
  scope: 'repo::acme/lore',
  key: 'k',
  value: 'v',
  tags: ['perf'],
  source_agent: 'agent0',
  trigger: 'hook',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-02T00:00:00.000Z',
  expires_at: null,
  archived_at: null,
};

describe('lessonFromMemoryEntry', () => {
  it('derives scope_type from the scope', () => {
    expect(lessonFromMemoryEntry(base).scope_type).toBe('repo');
  });

  it('carries the row id through, so a list row can address itself', () => {
    expect(lessonFromMemoryEntry(base).id).toBe(base.id);
  });

  it('normalises every optional field to null rather than leaving it undefined', () => {
    const lesson = lessonFromMemoryEntry(base);
    expect(lesson.origin_repo).toBeNull();
    expect(lesson.origin_branch).toBeNull();
    expect(lesson.origin_commit).toBeNull();
    expect(lesson.origin_pr).toBeNull();
    expect(lesson.created_by).toBeNull();
    expect(lesson.updated_by).toBeNull();
    expect(lesson.org_id).toBeNull();
  });

  it('leaves personal lore with no owner (undefined, not a placeholder org)', () => {
    expect(lessonFromMemoryEntry(base).org).toBeUndefined();
  });

  it('resolves the owner for org-owned lore', () => {
    const lesson = lessonFromMemoryEntry({
      ...base,
      org_id: '22222222-2222-4222-8222-222222222222',
      org: { id: '22222222-2222-4222-8222-222222222222', name: 'Acme', slug: 'acme' },
    });
    expect(lesson.org).toEqual({ id: '22222222-2222-4222-8222-222222222222', name: 'Acme' });
  });

  it('degrades to no owner when org_id is set but the embed did not resolve', () => {
    // Half-populated ownership must never render as an org with no name.
    const lesson = lessonFromMemoryEntry({
      ...base,
      org_id: '22222222-2222-4222-8222-222222222222',
      org: null,
    });
    expect(lesson.org).toBeUndefined();
    expect(lesson.org_id).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('defaults absent tags to an empty list', () => {
    const lesson = lessonFromMemoryEntry({ ...base, tags: undefined as unknown as string[] });
    expect(lesson.tags).toEqual([]);
  });

  it('carries an explicit kind/host/seen_count through unchanged', () => {
    const lesson = lessonFromMemoryEntry({ ...base, kind: 'lesson', host: 'reviewer', seen_count: 4 });
    expect(lesson.kind).toBe('lesson');
    expect(lesson.host).toBe('reviewer');
    expect(lesson.seen_count).toBe(4);
  });

  it('falls back to the loop-tag inference when kind/host are both absent', () => {
    // Same inference the write path and usage recorder use (`inferKindHost`),
    // reused rather than re-parsed, so a pre-00056 row still shows its family.
    const lesson = lessonFromMemoryEntry({ ...base, tags: ['loop::reviewer-lessons'] });
    expect(lesson.kind).toBe('lesson');
    expect(lesson.host).toBe('reviewer');
  });

  it('does not infer from tags when an explicit kind/host is already present', () => {
    // An explicit `kind` with no `host` (or vice versa) still counts as
    // "already present" — inference only runs when BOTH are absent, so a
    // legitimately host-less kind is never overwritten by tag-guessing.
    const lesson = lessonFromMemoryEntry({ ...base, kind: 'bus', tags: ['loop::reviewer-lessons'] });
    expect(lesson.kind).toBe('bus');
    expect(lesson.host).toBeNull();
  });

  it('leaves kind/host null and seen_count undefined when neither the row nor its tags carry them', () => {
    const lesson = lessonFromMemoryEntry(base);
    expect(lesson.kind).toBeNull();
    expect(lesson.host).toBeNull();
    expect(lesson.seen_count).toBeUndefined();
  });
});
