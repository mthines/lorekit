/**
 * Fail-closed behavioral proof (AC-14, plan.md v2 Slice E): a retention/groom
 * call refused by the key-scope allowlist gate must NEVER reach its mutation
 * RPC. Gating on the RPC's RETURNED row would be post-commit — a mutation
 * leak, not fail-closed — so this drives the real handlers against a mock
 * `DbClient` and asserts on the RECORDED call list, not merely on the thrown
 * error.
 *
 * Sibling of `tools.grooming-bounds.test.ts` (same Deno-test-against-tools.ts
 * approach). This one needs a `DbClient`/`Span` shape to hand the handlers,
 * so it builds a minimal mock rather than importing the real Supabase/OTel
 * types — both are structurally satisfied via `as unknown as` casts, which is
 * why this file typechecks without needing the Supabase import map.
 *
 * Run with: deno test --no-check supabase/functions/mcp/tools.policy-scope-gate.test.ts
 * (--no-check for the same reason as tools.grooming-bounds.test.ts: the
 * surrounding tree needs the full Supabase import map to typecheck; the real
 * type gate is `node scripts/ci/deno-check-functions.mjs`. NOT a CI job —
 * local-only, per plan.md's risk note; the CI-side recurrence guard is
 * `retention-scope-gate.spec.ts`, run under `pnpm nx test mcp-core`.)
 */
import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { KeyScopeDeniedError } from '../_shared/schemas/api-key.ts';
import type { KeyRestriction } from '../_shared/auth/tenant-scope.ts';
import {
  toolPolicyCreate,
  toolPolicyUpdate,
  toolPolicyDelete,
  toolGroomRun,
} from './tools.ts';

// ── Mock DbClient ────────────────────────────────────────────────────────────

interface RpcResult { data: unknown; error: unknown }

/** A thenable stand-in for a postgrest query builder, supporting `.single()`. */
function makeQb(result: RpcResult) {
  const qb = {
    single() { return qb; },
    then(
      resolve?: ((v: RpcResult) => unknown) | null,
      reject?: ((r: unknown) => unknown) | null,
    ) {
      return Promise.resolve(result).then(resolve ?? undefined, reject ?? undefined);
    },
  };
  return qb;
}

/**
 * A mock `DbClient` whose `.rpc()` records every call name (for the
 * fail-closed assertion) and answers from a fixed table of canned results.
 *
 * `.from()` is a no-op insert stub — every SUCCESS path here fires an audit
 * write (`recordAuditDeferred` -> `recordAudit` -> `.from('audit_log').insert(
 * …)`, `background()` returns null under `deno test`'s absent `EdgeRuntime`
 * global, so it awaits inline), and `recordAudit` already swallows any error
 * from it (by design — an audit failure must never fail the mutation it
 * records), so a missing stub is harmless but noisy in test output.
 */
function createMockDb(rpcResults: Record<string, RpcResult>, calls: string[]) {
  return {
    rpc(fn: string, _args?: Record<string, unknown>) {
      calls.push(fn);
      return makeQb(rpcResults[fn] ?? { data: null, error: { message: `unmocked rpc: ${fn}` } });
    },
    from(_table: string) {
      return { insert: (_row: Record<string, unknown>) => Promise.resolve({ data: null, error: null }) };
    },
  };
}

// ── Mock Span ────────────────────────────────────────────────────────────────

/** A no-op stand-in for `Span` — every method used by tools.ts, chainable. */
class FakeSpan {
  setAttributes(_attrs: Record<string, unknown>): this { return this; }
  child(_name: string, _attrs?: Record<string, unknown>, _kind?: unknown): FakeSpan { return new FakeSpan(); }
  detachedChild(_name: string, _attrs?: Record<string, unknown>) {
    return { span: new FakeSpan(), flush: () => Promise.resolve() };
  }
  clientError(_msg: string): this { return this; }
  error(_msg: string): this { return this; }
  end(): void { /* no batch to flush in this mock */ void 0; }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = 'user-1';
const ALLOWED_SCOPE = 'repo::mthines/a';
const FENCED_SCOPE = 'repo::other/b';

const RESTRICTED_EXACT: KeyRestriction = { scopes: [ALLOWED_SCOPE], orgAccess: 'all', orgIds: [] };
const RESTRICTED_WILDCARD: KeyRestriction = { scopes: ['repo::mthines/*'], orgAccess: 'all', orgIds: [] };

function makePolicyRow(overrides: Record<string, unknown>) {
  return {
    id: 'p-default',
    user_id: USER_ID,
    scope: ALLOWED_SCOPE,
    name: 'a policy',
    mode: 'review',
    enabled: false,
    min_age_days: null,
    unseen_days: null,
    max_seen_count: null,
    max_read_count: null,
    max_opened_count: null,
    tags: null,
    tags_mode: null,
    source_agent: null,
    source_agent_mode: null,
    trigger: null,
    trigger_mode: null,
    kind: null,
    kind_mode: null,
    host: null,
    host_mode: null,
    origin_repo: null,
    origin_repo_mode: null,
    origin_branch: null,
    origin_branch_mode: null,
    origin_pr: null,
    origin_pr_mode: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const FENCED_POLICY = makePolicyRow({ id: 'p-fenced', scope: FENCED_SCOPE, name: 'fenced' });
const ALLOWED_POLICY = makePolicyRow({ id: 'p-allowed', scope: ALLOWED_SCOPE, name: 'allowed' });

const POLICY_LIST_RESULT: RpcResult = { data: [FENCED_POLICY, ALLOWED_POLICY], error: null };

// ── toolPolicyCreate ─────────────────────────────────────────────────────────

Deno.test('toolPolicyCreate: a fenced scope throws KeyScopeDeniedError and never reaches lorekit_policy_create', async () => {
  const calls: string[] = [];
  const db = createMockDb({}, calls);
  await assertRejects(
    () => toolPolicyCreate(
      db as never, { scope: FENCED_SCOPE, name: 'x' }, USER_ID, new FakeSpan() as never, RESTRICTED_EXACT,
    ),
    KeyScopeDeniedError,
  );
  assert(!calls.includes('lorekit_policy_create'), 'lorekit_policy_create must never be called on denial');
});

Deno.test('toolPolicyCreate: an allowed scope reaches lorekit_policy_create', async () => {
  const calls: string[] = [];
  const db = createMockDb({
    lorekit_policy_create: { data: makePolicyRow({ id: 'p-new', scope: ALLOWED_SCOPE, name: 'x' }), error: null },
  }, calls);
  const row = await toolPolicyCreate(
    db as never, { scope: ALLOWED_SCOPE, name: 'x' }, USER_ID, new FakeSpan() as never, RESTRICTED_EXACT,
  );
  assertEquals((row as { scope: string }).scope, ALLOWED_SCOPE);
  assert(calls.includes('lorekit_policy_create'));
});

Deno.test('toolPolicyCreate: a wildcard-allowed scope reaches lorekit_policy_create', async () => {
  const calls: string[] = [];
  const db = createMockDb({
    lorekit_policy_create: { data: makePolicyRow({ id: 'p-new', scope: ALLOWED_SCOPE, name: 'x' }), error: null },
  }, calls);
  const row = await toolPolicyCreate(
    db as never, { scope: ALLOWED_SCOPE, name: 'x' }, USER_ID, new FakeSpan() as never, RESTRICTED_WILDCARD,
  );
  assertEquals((row as { scope: string }).scope, ALLOWED_SCOPE);
  assert(calls.includes('lorekit_policy_create'));
});

// ── toolPolicyUpdate ─────────────────────────────────────────────────────────

Deno.test('toolPolicyUpdate: a fenced STORED scope throws and never reaches lorekit_policy_update', async () => {
  const calls: string[] = [];
  const db = createMockDb({ lorekit_policy_list: POLICY_LIST_RESULT }, calls);
  await assertRejects(
    () => toolPolicyUpdate(
      db as never, { id: 'p-fenced', name: 'renamed' }, USER_ID, new FakeSpan() as never, RESTRICTED_EXACT,
    ),
    KeyScopeDeniedError,
  );
  assert(calls.includes('lorekit_policy_list'), 'the pre-fetch READ is expected');
  assert(!calls.includes('lorekit_policy_update'), 'lorekit_policy_update must never be called on denial');
});

Deno.test('toolPolicyUpdate: an allowed STORED scope reaches lorekit_policy_update', async () => {
  const calls: string[] = [];
  const db = createMockDb({
    lorekit_policy_list: POLICY_LIST_RESULT,
    lorekit_policy_update: { data: [makePolicyRow({ id: 'p-allowed', scope: ALLOWED_SCOPE, name: 'renamed' })], error: null },
  }, calls);
  await toolPolicyUpdate(
    db as never, { id: 'p-allowed', name: 'renamed' }, USER_ID, new FakeSpan() as never, RESTRICTED_EXACT,
  );
  assert(calls.includes('lorekit_policy_update'));
});

Deno.test('toolPolicyUpdate: a wildcard-allowed STORED scope reaches lorekit_policy_update', async () => {
  const calls: string[] = [];
  const db = createMockDb({
    lorekit_policy_list: POLICY_LIST_RESULT,
    lorekit_policy_update: { data: [makePolicyRow({ id: 'p-allowed', scope: ALLOWED_SCOPE, name: 'renamed' })], error: null },
  }, calls);
  await toolPolicyUpdate(
    db as never, { id: 'p-allowed', name: 'renamed' }, USER_ID, new FakeSpan() as never, RESTRICTED_WILDCARD,
  );
  assert(calls.includes('lorekit_policy_update'));
});

// ── toolPolicyDelete ─────────────────────────────────────────────────────────

Deno.test('toolPolicyDelete: a fenced STORED scope throws and never reaches lorekit_policy_delete', async () => {
  const calls: string[] = [];
  const db = createMockDb({ lorekit_policy_list: POLICY_LIST_RESULT }, calls);
  await assertRejects(
    () => toolPolicyDelete(
      db as never, { id: 'p-fenced' }, USER_ID, new FakeSpan() as never, RESTRICTED_EXACT,
    ),
    KeyScopeDeniedError,
  );
  assert(!calls.includes('lorekit_policy_delete'), 'lorekit_policy_delete must never be called on denial');
});

Deno.test('toolPolicyDelete: an allowed STORED scope reaches lorekit_policy_delete', async () => {
  const calls: string[] = [];
  const db = createMockDb({
    lorekit_policy_list: POLICY_LIST_RESULT,
    lorekit_policy_delete: { data: [makePolicyRow({ id: 'p-allowed', scope: ALLOWED_SCOPE })], error: null },
  }, calls);
  await toolPolicyDelete(
    db as never, { id: 'p-allowed' }, USER_ID, new FakeSpan() as never, RESTRICTED_EXACT,
  );
  assert(calls.includes('lorekit_policy_delete'));
});

Deno.test('toolPolicyDelete: a wildcard-allowed STORED scope reaches lorekit_policy_delete', async () => {
  const calls: string[] = [];
  const db = createMockDb({
    lorekit_policy_list: POLICY_LIST_RESULT,
    lorekit_policy_delete: { data: [makePolicyRow({ id: 'p-allowed', scope: ALLOWED_SCOPE })], error: null },
  }, calls);
  await toolPolicyDelete(
    db as never, { id: 'p-allowed' }, USER_ID, new FakeSpan() as never, RESTRICTED_WILDCARD,
  );
  assert(calls.includes('lorekit_policy_delete'));
});

// ── toolGroomRun ─────────────────────────────────────────────────────────────

Deno.test('toolGroomRun: a fenced INLINE scope throws and never reaches lorekit_groom_run', async () => {
  const calls: string[] = [];
  const db = createMockDb({}, calls);
  await assertRejects(
    () => toolGroomRun(
      db as never, { scope: FENCED_SCOPE }, USER_ID, new FakeSpan() as never, RESTRICTED_EXACT,
    ),
    KeyScopeDeniedError,
  );
  assert(!calls.includes('lorekit_groom_run'), 'lorekit_groom_run must never be called on denial');
});

Deno.test('toolGroomRun: an allowed INLINE scope reaches lorekit_groom_run', async () => {
  const calls: string[] = [];
  const db = createMockDb({
    lorekit_groom_run: { data: { archived: 0, keys: [] }, error: null },
  }, calls);
  await toolGroomRun(
    db as never, { scope: ALLOWED_SCOPE }, USER_ID, new FakeSpan() as never, RESTRICTED_EXACT,
  );
  assert(calls.includes('lorekit_groom_run'));
});

Deno.test('toolGroomRun: a wildcard-allowed INLINE scope reaches lorekit_groom_run', async () => {
  const calls: string[] = [];
  const db = createMockDb({
    lorekit_groom_run: { data: { archived: 0, keys: [] }, error: null },
  }, calls);
  await toolGroomRun(
    db as never, { scope: ALLOWED_SCOPE }, USER_ID, new FakeSpan() as never, RESTRICTED_WILDCARD,
  );
  assert(calls.includes('lorekit_groom_run'));
});

Deno.test('toolGroomRun: a fenced STORED scope via policy_id throws and never reaches lorekit_groom_run', async () => {
  const calls: string[] = [];
  const db = createMockDb({ lorekit_policy_list: POLICY_LIST_RESULT }, calls);
  await assertRejects(
    () => toolGroomRun(
      db as never, { policy_id: 'p-fenced' }, USER_ID, new FakeSpan() as never, RESTRICTED_EXACT,
    ),
    KeyScopeDeniedError,
  );
  assert(!calls.includes('lorekit_groom_run'), 'lorekit_groom_run must never be called on denial');
});

Deno.test('toolGroomRun: an allowed STORED scope via policy_id reaches lorekit_groom_run', async () => {
  const calls: string[] = [];
  const db = createMockDb({
    lorekit_policy_list: POLICY_LIST_RESULT,
    lorekit_groom_run: { data: { archived: 0, keys: [] }, error: null },
  }, calls);
  await toolGroomRun(
    db as never, { policy_id: 'p-allowed' }, USER_ID, new FakeSpan() as never, RESTRICTED_EXACT,
  );
  assert(calls.includes('lorekit_groom_run'));
});

// ── Unrestricted key is untouched ────────────────────────────────────────────

Deno.test('an UNRESTRICTED key (no restriction / empty scopes) reaches every RPC unchanged', async () => {
  const calls: string[] = [];
  const db = createMockDb({
    lorekit_policy_create: { data: makePolicyRow({ id: 'p-new', scope: FENCED_SCOPE, name: 'x' }), error: null },
  }, calls);
  // No restriction argument at all (JWT/service caller shape).
  await toolPolicyCreate(db as never, { scope: FENCED_SCOPE, name: 'x' }, USER_ID, new FakeSpan() as never);
  assert(calls.includes('lorekit_policy_create'));
});
