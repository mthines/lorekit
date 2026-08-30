// Session context derivation: `deriveSessionContext` (packages/cli/src/shared/mcp.mjs).
//
// Cross-language twin of packages/mcp-core/src/telemetry/session-kind.ts's
// `parseSessionKind` (the vocabulary; that file validates, this one derives —
// see the module docblock). No real environment or process is touched: every
// case passes its own `env` object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSessionContext, isSessionKind, normalizeCorrelationId } from '../src/shared/mcp.mjs';

test('resolves PR context to sessionKind "pr" with a pr: correlation id', () => {
  const ctx = deriveSessionContext({
    GITHUB_REPOSITORY: 'mthines/lorekit',
    GITHUB_REF: 'refs/pull/482/merge',
  });
  assert.deepEqual(ctx, { correlationId: 'pr:mthines/lorekit#482', sessionKind: 'pr' });
});

test('PR context wins over a bare CI flag when both are present', () => {
  const ctx = deriveSessionContext({
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'mthines/lorekit',
    GITHUB_REF: 'refs/pull/7/merge',
    GITHUB_RUN_ID: '999',
  });
  assert.equal(ctx.sessionKind, 'pr');
  assert.equal(ctx.correlationId, 'pr:mthines/lorekit#7');
});

test('resolves a plain CI run to sessionKind "ci" with a ci: correlation id', () => {
  const ctx = deriveSessionContext({
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'mthines/lorekit',
    GITHUB_RUN_ID: '123456',
  });
  assert.deepEqual(ctx, { correlationId: 'ci:mthines/lorekit#123456', sessionKind: 'ci' });
});

test('CI without a resolvable repo/run id is still "ci", with no correlation id', () => {
  const ctx = deriveSessionContext({ CI: 'true' });
  assert.deepEqual(ctx, { correlationId: null, sessionKind: 'ci' });
});

test('a local session id resolves to sessionKind "local"', () => {
  const ctx = deriveSessionContext({ LOREKIT_SESSION_ID: 'abc123' });
  assert.deepEqual(ctx, { correlationId: 'session:abc123', sessionKind: 'local' });
});

// Regression: `CLAUDE_SESSION_ID` was the only Claude name checked, and Claude
// Code does not export it — it exports `CLAUDE_CODE_SESSION_ID`. Every local
// Claude session therefore derived `unknown`/no correlation id, which is why
// the dashboard's Runs view was empty on an account with tens of thousands of
// usage events.
test('Claude Code\'s own CLAUDE_CODE_SESSION_ID resolves to sessionKind "local"', () => {
  const ctx = deriveSessionContext({ CLAUDE_CODE_SESSION_ID: 'cc-abc123' });
  assert.deepEqual(ctx, { correlationId: 'session:cc-abc123', sessionKind: 'local' });
});

test('the legacy CLAUDE_SESSION_ID name still resolves', () => {
  const ctx = deriveSessionContext({ CLAUDE_SESSION_ID: 'legacy-1' });
  assert.deepEqual(ctx, { correlationId: 'session:legacy-1', sessionKind: 'local' });
});

test('an explicit LOREKIT_SESSION_ID outranks the host-provided names', () => {
  const ctx = deriveSessionContext({
    LOREKIT_SESSION_ID: 'explicit',
    CLAUDE_CODE_SESSION_ID: 'cc-abc123',
  });
  assert.equal(ctx.correlationId, 'session:explicit');
});

test('no derivable context at all resolves to "unknown" with no correlation id', () => {
  const ctx = deriveSessionContext({});
  assert.deepEqual(ctx, { correlationId: null, sessionKind: 'unknown' });
});

test('never throws on a hostile/empty environment', () => {
  assert.doesNotThrow(() => deriveSessionContext({}));
  assert.doesNotThrow(() => deriveSessionContext({ GITHUB_REF: 123, GITHUB_RUN_ID: {} }));
});

test('a session id that fails the correlation-id charset degrades to no id, keeping the sessionKind', () => {
  const ctx = deriveSessionContext({ LOREKIT_SESSION_ID: 'has a space' });
  assert.equal(ctx.sessionKind, 'local');
  assert.equal(ctx.correlationId, null);
});

test('isSessionKind matches the closed vocabulary parseSessionKind (mcp-core) validates', () => {
  for (const kind of ['local', 'ci', 'pr', 'unknown']) assert.equal(isSessionKind(kind), true);
  assert.equal(isSessionKind('staging'), false);
  assert.equal(isSessionKind(undefined), false);
});

test('normalizeCorrelationId is re-exported and still enforces its own bound (regression guard)', () => {
  assert.equal(normalizeCorrelationId('a'.repeat(201)), null);
  assert.equal(normalizeCorrelationId('mthines/lorekit#123'), 'mthines/lorekit#123');
});
