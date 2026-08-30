import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard for the write-path embedder's authorisation.
 *
 * THE BUG THIS PINS. `_shared/embedding/embed-on-write.ts` used to update `memories`
 * directly with whatever client the request arrived on. The READ policies were
 * widened for orgs in 00015 (`org_id in (select lorekit_member_org_ids(…))`);
 * `rls_update` (00001) never was. An org-owned memory carries `user_id is null`
 * (00019), so under a JWT client that update matched ZERO ROWS — and PostgREST
 * does not call a zero-row update an error. Every org memory silently went
 * unembedded, and nothing anywhere said so.
 *
 * Migration 00062 moves the write behind `lorekit_memory_set_embedding`, which
 * authorises inside itself. The behavioural proof lives in
 * `supabase/tests/migrations.test.sql` (section 62) and needs a real database.
 * This is the cheap half that runs on every `nx test mcp-core`: it asserts the
 * edge module cannot QUIETLY regress to the direct-update shape.
 *
 * Source scan rather than a behavioural test for the same reason
 * `org-actor-usage.spec.ts`, `tenant-scope-usage.spec.ts` and
 * `rest-audit-usage.spec.ts` are: the failure is invisible on the tier most
 * likely to be exercised (a personal row under a JWT works fine either way), so
 * the guard has to be structural.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src/mcp-guards
const repoRoot = path.resolve(here, '../../../..');
const embedOnWrite = path.join(repoRoot, 'supabase', 'functions', '_shared', 'embedding', 'embed-on-write.ts');
const createHandler = path.join(
  repoRoot, 'supabase', 'functions', 'memories', 'handlers', 'create.ts',
);
const migration = path.join(
  repoRoot, 'supabase', 'migrations', '00062_memory_embedding_write.sql',
);

const source = readFileSync(embedOnWrite, 'utf8');
const handler = readFileSync(createHandler, 'utf8');

/** Executable lines only — the docblocks here describe the very shape being banned. */
function executable(src: string): string {
  return src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
    .join('\n');
}

const code = executable(source);

describe('embed-on-write authorisation (00062)', () => {
  it('writes the vector through lorekit_memory_set_embedding', () => {
    expect(
      /\.\brpc\b\s*(?:<[^>]*>)?\s*\(\s*['"]lorekit_memory_set_embedding['"]/.test(code),
      'embed-on-write.ts must write the embedding through the lorekit_memory_set_embedding RPC ' +
        '(migration 00062), which authorises the write inside the function.',
    ).toBe(true);
  });

  it('does NOT update the memories table directly', () => {
    // The exact shape of the regression: `.from('memories').update(...)`.
    // Under a JWT client this matches zero rows for an org-owned memory and
    // reports no error — the embedding is dropped with no signal at all.
    expect(
      /\.\bfrom\b\s*\(\s*['"]memories['"]\s*\)[\s\S]{0,200}?\.\bupdate\b\s*\(/.test(code),
      'embed-on-write.ts updates `memories` directly again. That silently no-ops for org-owned ' +
        'rows (user_id is null per 00019, and rls_update was never widened for orgs the way ' +
        'rls_read was in 00015). Write through lorekit_memory_set_embedding instead.',
    ).toBe(false);
  });

  it('passes an explicit actor supplied by the caller', () => {
    // The api_key tier reaches Postgres over a service-role connection where
    // auth.uid() is NULL, so without an explicit actor every capability check
    // inside the RPC denies — invisibly, because JWT calls keep working.
    expect(
      /\bp_actor_user_id\b/.test(code),
      'embed-on-write.ts must pass p_actor_user_id — without it the RPC denies every api_key call.',
    ).toBe(true);
  });

  it('the call site sources that actor from the shared actorUserId helper', () => {
    expect(
      /\bactorUserId\s*\(/.test(handler),
      'memories/handlers/create.ts must pass actorUserId(auth) to embedOnWrite rather than ' +
        'inlining `auth.userId ?? null` — the same rule org-actor-usage.spec.ts enforces for org RPCs.',
    ).toBe(true);
    expect(handler).toMatch(
      /import\s*\{[^}]*\bactorUserId\b[^}]*\}\s*from\s*['"][^'"]*_shared\/api\/auth\.ts['"]/,
    );
  });

  it('reports a write that matched no row instead of assuming success', () => {
    // The half of the fix that outlives this specific bug: a miss becomes a
    // span signal rather than an empty column nobody notices.
    expect(
      /matched no row/.test(source),
      'A write that matches nothing must be recorded on the span. Silence is what made the ' +
        'org-owned case survive six review rounds.',
    ).toBe(true);
  });
});

describe('migration 00062', () => {
  const sql = readFileSync(migration, 'utf8');

  it('is SECURITY DEFINER and revokes the default PUBLIC execute grant', () => {
    expect(sql).toMatch(/security\s+definer/i);
    // Postgres grants EXECUTE to PUBLIC by default and `anon` inherits it, so
    // naming `authenticated, service_role` in a GRANT does NOT withhold it —
    // the trap 00041 documents and migrations.test.sql asserts on.
    expect(
      /revoke\s+execute\s+on\s+function\s+lorekit_memory_set_embedding/i.test(sql),
      'The REVOKE ... FROM PUBLIC is load-bearing, not decorative — without it anon inherits EXECUTE.',
    ).toBe(true);
  });

  it('names `extensions` in its search_path so the vector cast resolves on hosted Supabase', () => {
    // Supabase provisions `vector` in the `extensions` schema on hosted
    // projects (00060's header). A function pinned to `public` alone resolves
    // locally and fails in production with `type "vector" does not exist` —
    // inside a backgrounded task whose errors are swallowed by design.
    expect(sql).toMatch(/set\s+search_path\s*=\s*public\s*,\s*extensions/i);
  });

  it('gates an org-owned row on the write capability, not mere membership', () => {
    expect(
      /lorekit_org_can\s*\(/.test(sql),
      'An org VIEWER must not be able to write an embedding. This is the reason 00062 is an RPC ' +
        'rather than a widened rls_update policy — RLS cannot express the role gate.',
    ).toBe(true);
  });
});
