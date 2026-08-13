import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryEntryFromLocal } from './memory-entry.mjs';
import { syntheticId } from './synthetic-id.mjs';
// Test-only dependency (devDependencies in package.json) — never imported by
// shipped src/bin code, so the CLI itself stays zero-dependency (AC-13). This
// is the "parse the real schema" half of AC-15/AC-8.
import { MemoryEntrySchema } from '@lorekit/schemas/memory';

function baseRow(overrides = {}) {
  return {
    scope: 'global',
    key: 'my-key',
    value: 'the lesson body',
    tags: ['perf', 'ci'],
    source_agent: 'claude',
    trigger: 'stuck-loop',
    origin_repo: 'acme/widget',
    origin_branch: 'main',
    origin_commit: 'abc123',
    origin_pr: 42,
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-02T00:00:00.000Z',
    archived_at: null,
    expires_at: null,
    seen_count: 3,
    ...overrides,
  };
}

test('memoryEntryFromLocal produces a row that validates against the real MemoryEntrySchema', () => {
  const entry = memoryEntryFromLocal(baseRow());
  const parsed = MemoryEntrySchema.parse(entry);
  assert.equal(parsed.scope, 'global');
  assert.equal(parsed.key, 'my-key');
  assert.equal(parsed.value, 'the lesson body');
  assert.deepEqual(parsed.tags, ['perf', 'ci']);
  assert.equal(parsed.source_agent, 'claude');
  assert.equal(parsed.origin_pr, 42);
  assert.equal(parsed.seen_count, 3);
});

test('the id is the deterministic synthetic id of scope::key', () => {
  const entry = memoryEntryFromLocal(baseRow());
  assert.equal(entry.id, syntheticId('global', 'my-key'));
});

test('null/absent optional fields translate to null, not undefined or fabricated values', () => {
  const entry = memoryEntryFromLocal(baseRow({
    source_agent: null, trigger: null, origin_repo: null, origin_branch: null,
    origin_commit: null, origin_pr: null, archived_at: null, expires_at: null,
  }));
  const parsed = MemoryEntrySchema.parse(entry);
  assert.equal(parsed.source_agent, null);
  assert.equal(parsed.trigger, null);
  assert.equal(parsed.origin_pr, null);
  assert.equal(parsed.archived_at, null);
  assert.equal(parsed.expires_at, null);
  assert.equal(parsed.org, null);
  assert.equal(parsed.org_id, null);
});

test('a non-ISO created/updated value falls back to now rather than failing schema validation', () => {
  const entry = memoryEntryFromLocal(baseRow({ created: 'not-a-date', updated: '' }));
  // Must not throw, and must produce a schema-valid datetime.
  const parsed = MemoryEntrySchema.parse(entry);
  assert.ok(!Number.isNaN(new Date(parsed.created_at).getTime()));
  assert.ok(!Number.isNaN(new Date(parsed.updated_at).getTime()));
});

test('archived_at and expires_at round-trip as ISO strings when present', () => {
  const entry = memoryEntryFromLocal(baseRow({
    archived_at: '2026-02-01T00:00:00.000Z',
    expires_at: '2026-03-01T00:00:00.000Z',
  }));
  const parsed = MemoryEntrySchema.parse(entry);
  assert.equal(parsed.archived_at, '2026-02-01T00:00:00.000Z');
  assert.equal(parsed.expires_at, '2026-03-01T00:00:00.000Z');
});

test('is total: a malformed/empty row still yields a schema-valid entry', () => {
  const parsed = MemoryEntrySchema.parse(memoryEntryFromLocal({}));
  assert.equal(parsed.scope, '');
  assert.equal(parsed.key, '');
  assert.equal(parsed.value, '');
  assert.deepEqual(parsed.tags, []);
});

test('seen_count floors a fractional/negative/unusable value, defaulting to 1', () => {
  assert.equal(memoryEntryFromLocal(baseRow({ seen_count: undefined })).seen_count, 1);
  assert.equal(memoryEntryFromLocal(baseRow({ seen_count: 4.9 })).seen_count, 4);
  assert.equal(memoryEntryFromLocal(baseRow({ seen_count: -3 })).seen_count, 0);
  assert.equal(memoryEntryFromLocal(baseRow({ seen_count: '7' })).seen_count, 7);
});

test('kind/host are null — the local store has no taxonomy columns yet', () => {
  const entry = memoryEntryFromLocal(baseRow());
  assert.equal(entry.kind, null);
  assert.equal(entry.host, null);
});
