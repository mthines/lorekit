import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDataset, SEED_KEY_PREFIX, SEED_ORG_ID } from './preview-dataset.mjs';

const NOW = new Date('2026-09-10T12:00:00.000Z');

test('every memory key carries the seed prefix, and (scope,key) pairs are unique', () => {
  const { memories } = buildDataset({ now: NOW });
  assert.ok(memories.length > 20, 'expected a real dataset, not a stub');
  const seen = new Set();
  for (const m of memories) {
    assert.ok(m.key.startsWith(SEED_KEY_PREFIX), `key "${m.key}" missing the seed prefix`);
    const pair = `${m.scope}::${m.key}`;
    assert.ok(!seen.has(pair), `duplicate (scope,key): ${pair}`);
    seen.add(pair);
  }
});

test('every Explorer filter dimension has at least three distinct values', () => {
  const { memories } = buildDataset({ now: NOW });
  const dims = {
    kind: new Set(), host: new Set(), source_agent: new Set(), trigger: new Set(),
    origin_repo: new Set(), origin_branch: new Set(), origin_pr: new Set(), scope: new Set(),
  };
  for (const m of memories) {
    for (const key of Object.keys(dims)) {
      if (m[key] !== null && m[key] !== undefined) dims[key].add(m[key]);
    }
  }
  for (const [key, set] of Object.entries(dims)) {
    assert.ok(set.size >= 3, `dimension "${key}" only has ${set.size} distinct value(s): ${[...set]}`);
  }
});

test('every scope type (global/project/repo/branch) is represented', () => {
  const { memories } = buildDataset({ now: NOW });
  const types = new Set(memories.map((m) => m.scopeType));
  for (const t of ['global', 'project', 'repo', 'branch']) {
    assert.ok(types.has(t), `no memory uses scope type "${t}"`);
  }
});

test('at least one memory is archived, one protected, one expired, and one with an active ttl', () => {
  const { memories } = buildDataset({ now: NOW });
  assert.ok(memories.some((m) => m.archived_at !== null), 'expected at least one archived memory');
  assert.ok(memories.some((m) => m.protected === true), 'expected at least one protected memory');
  const expired = memories.filter((m) => m.expires_at !== null && new Date(m.expires_at) < NOW);
  const active = memories.filter((m) => m.expires_at !== null && new Date(m.expires_at) >= NOW);
  assert.ok(expired.length > 0, 'expected at least one already-expired memory');
  assert.ok(active.length > 0, 'expected at least one memory with an active (future) ttl');
});

test('at least one memory is org-owned, and org_id always points at the seed org', () => {
  const { memories, org } = buildDataset({ now: NOW });
  const owned = memories.filter((m) => m.org_id !== null);
  assert.ok(owned.length > 0, 'expected at least one org-owned memory');
  for (const m of owned) assert.equal(m.org_id, org.id);
  assert.equal(org.id, SEED_ORG_ID);
});

test('no timestamp is in the future, except an active-ttl expires_at', () => {
  const { memories, readDaily, citations, usageEvents } = buildDataset({ now: NOW });
  for (const m of memories) {
    for (const field of ['created_at', 'updated_at', 'archived_at', 'last_read_at', 'last_opened_at', 'last_cited_at']) {
      if (m[field]) assert.ok(new Date(m[field]) <= NOW, `${field} "${m[field]}" on ${m.key} is in the future`);
    }
  }
  for (const r of readDaily) assert.ok(new Date(r.day) <= NOW, `read_daily day "${r.day}" is in the future`);
  for (const c of citations) assert.ok(new Date(c.created_at) <= NOW, `citation created_at "${c.created_at}" is in the future`);
  for (const e of usageEvents) assert.ok(new Date(e.created_at) <= NOW, `usage_event created_at "${e.created_at}" is in the future`);
});

test('read-daily and citation rows only reference memory ids that exist in the dataset', () => {
  const { memories, readDaily, citations } = buildDataset({ now: NOW });
  const ids = new Set(memories.map((m) => m.id));
  for (const r of readDaily) assert.ok(ids.has(r.memory_id), `read_daily references unknown memory_id ${r.memory_id}`);
  for (const c of citations) assert.ok(ids.has(c.cited_memory_id), `citation references unknown memory_id ${c.cited_memory_id}`);
});

test('a memory\'s citation row count matches its cited_count exactly', () => {
  const { memories, citations } = buildDataset({ now: NOW });
  const countsByMemory = new Map();
  for (const c of citations) countsByMemory.set(c.cited_memory_id, (countsByMemory.get(c.cited_memory_id) ?? 0) + 1);
  for (const m of memories) {
    assert.equal(countsByMemory.get(m.id) ?? 0, m.cited_count, `citation rows for "${m.key}" don't match cited_count`);
  }
});

test('a memory with zero read_count has no read_daily rows', () => {
  const { memories, readDaily } = buildDataset({ now: NOW });
  const memoriesWithReads = new Set(readDaily.map((r) => r.memory_id));
  for (const m of memories) {
    if (m.read_count === 0) assert.ok(!memoriesWithReads.has(m.id), `"${m.key}" has read_count 0 but has read_daily rows`);
  }
});

test('usage_events cover the requested window and every outcome/client value used elsewhere is well-formed', () => {
  const { usageEvents } = buildDataset({ now: NOW, days: 14 });
  assert.ok(usageEvents.length > 50, 'expected a substantial event volume');
  for (const e of usageEvents) {
    assert.ok(['ok', 'rate_limited', 'cap_exceeded', 'permission_denied', 'error'].includes(e.outcome));
    assert.ok(['api_key', 'jwt', 'service'].includes(e.auth_type));
    assert.ok(e.client.length >= 1 && e.client.length <= 32);
    if (e.session_kind) assert.ok(e.session_kind.length <= 16);
  }
  const oldest = usageEvents.reduce((min, e) => Math.min(min, new Date(e.created_at).getTime()), Infinity);
  assert.ok(NOW.getTime() - oldest <= 14 * 24 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000, 'an event falls outside the requested window');
});

test('is deterministic — the same `now` always produces the same dataset', () => {
  const a = buildDataset({ now: NOW });
  const b = buildDataset({ now: NOW });
  assert.deepEqual(a, b);
});
