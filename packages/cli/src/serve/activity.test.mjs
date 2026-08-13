import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeActivity } from './activity.mjs';

const NOW = '2026-06-15T12:00:00.000Z';

function row(overrides = {}) {
  return {
    scope: 'global', created_at: '2026-06-01T10:00:00.000Z',
    archived_at: null, expires_at: null,
    ...overrides,
  };
}

test('buckets live rows by UTC day per scope', () => {
  const rows = [
    row({ created_at: '2026-06-01T05:00:00.000Z', scope: 'global' }),
    row({ created_at: '2026-06-01T20:00:00.000Z', scope: 'global' }),
    row({ created_at: '2026-06-02T00:30:00.000Z', scope: 'repo::acme/x' }),
  ];
  const res = computeActivity(rows, { bucket: 'day', now: NOW });
  assert.equal(res.bucket, 'day');
  const globalDay1 = res.buckets.find((b) => b.bucket === '2026-06-01T00:00:00.000Z' && b.scope === 'global');
  assert.equal(globalDay1.count, 2, 'both rows on 2026-06-01 (UTC) must fall into the same day bucket');
  const repoDay2 = res.buckets.find((b) => b.bucket === '2026-06-02T00:00:00.000Z' && b.scope === 'repo::acme/x');
  assert.equal(repoDay2.count, 1);
});

test('bucket=hour anchors at the start of the UTC hour', () => {
  const rows = [row({ created_at: '2026-06-01T05:12:00.000Z' }), row({ created_at: '2026-06-01T05:58:00.000Z' })];
  const res = computeActivity(rows, { bucket: 'hour', now: NOW });
  const hit = res.buckets.find((b) => b.bucket === '2026-06-01T05:00:00.000Z');
  assert.equal(hit.count, 2);
});

test('archived rows are excluded', () => {
  const rows = [row({ archived_at: '2026-06-02T00:00:00.000Z' })];
  const res = computeActivity(rows, { now: NOW });
  assert.equal(res.buckets.length, 0);
});

test('expired rows are excluded', () => {
  const rows = [row({ expires_at: '2026-06-02T00:00:00.000Z' })];
  const res = computeActivity(rows, { now: NOW });
  assert.equal(res.buckets.length, 0);
});

test('a non-expired TTL row is still counted', () => {
  const rows = [row({ expires_at: '2099-01-01T00:00:00.000Z' })];
  const res = computeActivity(rows, { now: NOW });
  assert.equal(res.buckets.length, 1);
});

test('the window is half-open [since, until)', () => {
  const rows = [
    row({ created_at: '2026-06-01T00:00:00.000Z' }), // == since -> included
    row({ created_at: '2026-06-03T00:00:00.000Z' }), // == until -> excluded
    row({ created_at: '2026-06-02T00:00:00.000Z' }), // strictly inside -> included
  ];
  const res = computeActivity(rows, { since: '2026-06-01T00:00:00.000Z', until: '2026-06-03T00:00:00.000Z', now: NOW });
  const total = res.buckets.reduce((s, b) => s + b.count, 0);
  assert.equal(total, 2);
});

test('with no since/until it defaults to a bounded trailing window ending now', () => {
  const rows = [row({ created_at: NOW })];
  const res = computeActivity(rows, { now: NOW });
  assert.equal(res.until, NOW);
  assert.ok(new Date(res.since).getTime() < new Date(NOW).getTime());
});

test('results are sorted bucket asc, scope asc, and the response is sparse', () => {
  const rows = [
    row({ created_at: '2026-06-02T00:00:00.000Z', scope: 'z' }),
    row({ created_at: '2026-06-01T00:00:00.000Z', scope: 'b' }),
    row({ created_at: '2026-06-01T00:00:00.000Z', scope: 'a' }),
  ];
  const res = computeActivity(rows, { now: NOW });
  assert.deepEqual(res.buckets.map((b) => `${b.bucket}/${b.scope}`), [
    '2026-06-01T00:00:00.000Z/a',
    '2026-06-01T00:00:00.000Z/b',
    '2026-06-02T00:00:00.000Z/z',
  ]);
});
