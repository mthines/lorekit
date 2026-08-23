import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRunEnvironment } from '../src/shared/mcp.mjs';

// The deployment-environment marker restFetch attaches as
// X-LoreKit-Deployment-Environment when DEPLOYMENT_ENVIRONMENT (or
// OTEL_DEPLOYMENT_ENVIRONMENT) is set — the edge reports it as
// `deployment.environment.name` (honouring only the synthetic `test`), so a
// smoke run's downstream spans filter apart from real traffic. Bounds mirror the
// edge's `resolveEnvironmentOverride` charset (supabase/functions/_shared/otel.ts)
// and `testRunHeaders` (packages/smoke-tests/src/smoke-telemetry.ts).

test('normalizeRunEnvironment accepts bounded environment names, trimmed', () => {
  assert.equal(normalizeRunEnvironment('test'), 'test');
  assert.equal(normalizeRunEnvironment('  test  '), 'test');
  assert.equal(normalizeRunEnvironment('preview'), 'preview');
  assert.equal(normalizeRunEnvironment('staging-2'), 'staging-2');
});

test('normalizeRunEnvironment rejects empty, over-long, out-of-charset, non-string', () => {
  assert.equal(normalizeRunEnvironment(''), null);
  assert.equal(normalizeRunEnvironment('   '), null);
  assert.equal(normalizeRunEnvironment('a'.repeat(65)), null);
  assert.equal(normalizeRunEnvironment('has spaces'), null);
  assert.equal(normalizeRunEnvironment('semi;colon'), null);
  assert.equal(normalizeRunEnvironment(undefined), null);
  assert.equal(normalizeRunEnvironment(null), null);
  assert.equal(normalizeRunEnvironment(42), null);
});
