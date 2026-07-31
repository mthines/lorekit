import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCorrelationId } from '../src/mcp.mjs';

// The opt-in usage correlation id restFetch attaches as X-LoreKit-Correlation-Id
// when LOREKIT_CORRELATION_ID is set. Bounds must match the server's
// parseCorrelationId (supabase/functions/_shared/usage-stats.ts).

test('normalizeCorrelationId accepts bounded PR/session identifiers, trimmed', () => {
  assert.equal(normalizeCorrelationId('mthines/lorekit#123'), 'mthines/lorekit#123');
  assert.equal(normalizeCorrelationId('session_019Xyz'), 'session_019Xyz');
  assert.equal(normalizeCorrelationId('  pr-42  '), 'pr-42');
  assert.equal(normalizeCorrelationId('feat/usage-stats:1'), 'feat/usage-stats:1');
});

test('normalizeCorrelationId rejects empty, over-long, out-of-charset, non-string', () => {
  assert.equal(normalizeCorrelationId(''), null);
  assert.equal(normalizeCorrelationId('   '), null);
  assert.equal(normalizeCorrelationId('a'.repeat(201)), null);
  assert.equal(normalizeCorrelationId('has spaces'), null);
  assert.equal(normalizeCorrelationId(undefined), null);
  assert.equal(normalizeCorrelationId(null), null);
  assert.equal(normalizeCorrelationId(42), null);
});
