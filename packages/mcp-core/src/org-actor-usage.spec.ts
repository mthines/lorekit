import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard: the two things that make `supabase/functions/orgs/` safe to
 * expose to `lk_*` API tokens.
 *
 * Those routes used to be `requires: 'jwt'`, so every handler could lean on two
 * properties of the JWT client that the api_key tier does NOT have:
 *
 *   1. `auth.uid()` is populated inside the RPCs. On the api_key tier the edge
 *      function talks to Postgres with the SERVICE-ROLE key, so `auth.uid()` is
 *      NULL and every `lorekit_org_can(...)` denies. Migration
 *      `00041_org_actor_override.sql` adds a trailing `p_actor_user_id` to the
 *      eight org RPCs the REST surface calls; a handler that forgets to pass it
 *      breaks that route for API tokens — invisibly, because JWT calls keep
 *      working.
 *   2. RLS narrows every raw table read. It does not on a service-role client.
 *      A `from('org_members')` with no filter returns EVERY membership row in
 *      the database, and a `from('orgs').eq('slug', …)` returns any org whose
 *      slug you can guess. Both were exactly the shape of the read handlers
 *      before this change.
 *
 * Failure mode (1) degrades a feature; failure mode (2) is a cross-tenant data
 * leak. Neither is visible in a JWT-only test run, which is why this is a
 * source scan rather than a behavioural test — mirroring
 * `tenant-scope-usage.spec.ts` (the same guard for the MCP read path) and
 * `rest-audit-usage.spec.ts`.
 *
 * This checks CALL PRESENCE, not correctness: that the argument object mentions
 * `p_actor_user_id`, and that a file doing a raw read on an org table also
 * references the shared membership check. Whether the check is applied to the
 * RIGHT org, on the right branch, is a review concern. What it guarantees is
 * that neither can go missing SILENTLY.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src
const repoRoot = path.resolve(here, '../../..');
const handlersDir = path.join(repoRoot, 'supabase', 'functions', 'orgs', 'handlers');

/**
 * Org RPCs that deliberately take NO actor override, and so must NOT be
 * expected to pass one.
 *
 * `lorekit_org_leave` is the only entry, and it is not an oversight: 00041
 * deliberately leaves it (with `_invite_accept` / `_invite_decline`) on a pure
 * `auth.uid()` actor. Accept/decline match the invite against the caller's
 * VERIFIED JWT identity claims, which a service-role connection has no
 * equivalent of; leave is held back with them rather than diverging alone. The
 * consequence is documented at its call site: self-removal via an API token
 * fails closed with LK002 rather than removing the wrong row.
 *
 * Adding an entry here means "this RPC resolves its own actor and an override
 * would be unsafe or meaningless" — never "I could not get it to work".
 */
const ACTOR_EXEMPT_RPCS: Record<string, string> = {
  lorekit_org_leave:
    'Resolves the actor as auth.uid() by design (00041 header) — kept aligned with invite accept/decline, ' +
    'which match verified JWT identity claims that service_role cannot supply.',
};

/** Raw table reads that carry no RLS on the api_key tier's service-role client. */
const TENANT_TABLES = ['orgs', 'org_members', 'org_invites'];

/**
 * The shared membership/tenant helpers in `_shared/api/tenant.ts`. A handler
 * doing a raw read on a tenant table must reference at least one.
 */
const TENANT_CHECKS = ['isOrgMember', 'applyOwnMembershipFilter', 'hasOrgCapability'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const handlerFiles = walk(handlersDir).sort();

interface RpcCall {
  file: string;
  fn: string;
  args: string;
}

/**
 * `.rpc('lorekit_org_x', { … })` or `.rpc<Row>('lorekit_org_x', { … })`.
 * `\b` anchored so a differently-named helper (`myRpc(`) is not picked up.
 */
const RPC_PATTERN = /\.\brpc\b\s*(?:<[^>]*>)?\s*\(\s*'(lorekit_org_[a-z_]+)'/g;

/** Slice the full `.rpc(...)` argument list by counting parens from its `(`. */
function sliceCall(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(openParen + 1, i);
  }
  throw new Error(`unbalanced parentheses starting at offset ${openParen}`);
}

const rpcCalls: RpcCall[] = [];
for (const file of handlerFiles) {
  const source = readFileSync(file, 'utf8');
  RPC_PATTERN.lastIndex = 0;
  for (const m of source.matchAll(RPC_PATTERN)) {
    const openParen = source.indexOf('(', m.index! + '.rpc'.length);
    rpcCalls.push({ file, fn: m[1]!, args: sliceCall(source, openParen) });
  }
}

const gatedRpcCalls = rpcCalls.filter((c) => !(c.fn in ACTOR_EXEMPT_RPCS));

/**
 * Files that read a tenant table directly rather than through an RPC.
 *
 * Deliberately NOT a `/g` regex: `RegExp.prototype.test` on a global regex
 * advances `lastIndex` between calls, so reusing one across files silently
 * skips matches. That bug hid two handlers from this guard while it was being
 * written.
 */
const RAW_READ_PATTERN = new RegExp(
  String.raw`\.\bfrom\b\s*(?:<[^>]*>)?\s*\(\s*'(${TENANT_TABLES.join('|')})'\s*\)`,
);

/**
 * Handlers whose raw tenant-table read needs no membership check, with the
 * reason. Keep this as close to empty as possible — an entry here is a hole in
 * the guard, so it must be justified by the read being unable to see another
 * tenant's row by construction, never merely "it looked fine".
 */
const RAW_READ_EXEMPT: Record<string, string> = {
  'supabase/functions/orgs/handlers/orgs/create.ts':
    'The only read is the created row echoed back by id — `.eq("id", orgId)` where orgId is ' +
    'what lorekit_org_create just returned, and that RPC makes the caller the org owner in the ' +
    'same transaction. A membership check could not fail, and there is no other tenant\'s row ' +
    'the query could reach. The read exists because the route\'s OpenAPI response schema is an ' +
    'Org object while the RPC yields only a bare uuid.',
};

const rel = (f: string) => path.relative(repoRoot, f);

const rawReadFilesAll = handlerFiles.filter((f) => RAW_READ_PATTERN.test(readFileSync(f, 'utf8')));
const rawReadFiles = rawReadFilesAll.filter((f) => !(rel(f) in RAW_READ_EXEMPT));

describe('org handler scan (anti-vacuity)', () => {
  // Without these floors a stale regex yields an empty set and every
  // per-file assertion below passes vacuously — the way a drift guard rots
  // into decoration.
  it('found the org handler files', () => {
    expect(handlerFiles.length, `no .ts files under ${rel(handlersDir)}`).toBeGreaterThanOrEqual(11);
  });

  it('parsed a plausible number of lorekit_org_* RPC call sites', () => {
    expect(
      rpcCalls.length,
      `only ${rpcCalls.length} lorekit_org_* RPC calls found — RPC_PATTERN is probably stale`,
    ).toBeGreaterThanOrEqual(9);
    expect(gatedRpcCalls.length).toBeGreaterThanOrEqual(8);
  });

  it('found the handlers that read a tenant table directly', () => {
    expect(
      rawReadFilesAll.length,
      'no handler was found reading orgs/org_members/org_invites directly — RAW_READ_PATTERN is probably stale',
    ).toBeGreaterThanOrEqual(7);
  });

  it('has no stale entry in RAW_READ_EXEMPT', () => {
    // An exemption for a handler that no longer reads a tenant table is dead
    // weight that makes the next reader trust a hole that isn't there.
    const reading = new Set(rawReadFilesAll.map(rel));
    const stale = Object.keys(RAW_READ_EXEMPT).filter((f) => !reading.has(f));
    expect(stale, 'RAW_READ_EXEMPT names handlers that no longer read a tenant table — drop them').toEqual([]);
  });

  it('has no stale entry in ACTOR_EXEMPT_RPCS', () => {
    const called = new Set(rpcCalls.map((c) => c.fn));
    const stale = Object.keys(ACTOR_EXEMPT_RPCS).filter((fn) => !called.has(fn));
    expect(stale, 'ACTOR_EXEMPT_RPCS names RPCs no org handler calls any more — drop them').toEqual([]);
  });
});

describe('every org RPC call passes an explicit actor', () => {
  it.each(gatedRpcCalls.map((c) => [`${rel(c.file)} -> ${c.fn}`, c] as const))(
    '%s passes p_actor_user_id',
    (_label, call) => {
      expect(
        /\bp_actor_user_id\b/.test(call.args),
        `${rel(call.file)} calls ${call.fn} without p_actor_user_id. On the api_key tier the RPC runs over a ` +
          'service-role connection where auth.uid() is NULL, so lorekit_org_can() denies every capability and the ' +
          'route 403s for API tokens while continuing to work under a JWT. Pass `p_actor_user_id: actorUserId(auth)` ' +
          '(supabase/functions/_shared/api/auth.ts), or add a justified ACTOR_EXEMPT_RPCS entry.',
      ).toBe(true);

      // It must come from the ONE shared helper. `auth.userId ?? null` inlined
      // per call site is what this guard exists to prevent: the omission is
      // invisible under JWT auth, so consistency has to be structural.
      expect(
        /\bactorUserId\s*\(/.test(call.args),
        `${rel(call.file)} passes p_actor_user_id to ${call.fn} but not via actorUserId(auth) — use the shared helper.`,
      ).toBe(true);
    },
  );

  it.each(
    [...new Set(gatedRpcCalls.map((c) => c.file))].map((f) => [rel(f), f] as const),
  )('%s imports actorUserId from _shared/api/auth.ts', (_label, file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).toMatch(
      /import\s*\{[^}]*\bactorUserId\b[^}]*\}\s*from\s*['"][^'"]*_shared\/api\/auth\.ts['"]/,
    );
  });
});

describe('every raw org-table read is membership-checked', () => {
  it.each(rawReadFiles.map((f) => [rel(f), f] as const))(
    '%s applies a tenant/membership check',
    (_label, file) => {
      const source = readFileSync(file, 'utf8');
      const used = TENANT_CHECKS.filter((c) => new RegExp(String.raw`\b${c}\s*\(`).test(source));

      expect(
        used,
        `${rel(file)} reads ${TENANT_TABLES.join('/')} directly but references none of ` +
          `${TENANT_CHECKS.join('/')}. Those reads are gated by RLS only on the JWT client; the api_key tier uses a ` +
          'service-role client with no RLS at all, so an unfiltered read returns other tenants\' rows. Apply a check ' +
          'from supabase/functions/_shared/api/tenant.ts.',
      ).not.toEqual([]);

      // Same reasoning as above: it has to be the shared module, not a
      // hand-rolled membership query that can drift from
      // lorekit_member_org_ids.
      expect(source).toMatch(
        /import\s*\{[^}]*\}\s*from\s*['"][^'"]*_shared\/api\/tenant\.ts['"]/,
      );
    },
  );
});

/**
 * The same two properties, for the MCP org tools.
 *
 * The scan above walks `supabase/functions/orgs/handlers/` only, because when it
 * was written the MCP `org.*` tools were JWT-only and could legitimately lean on
 * `auth.uid()` and RLS. They now serve `lk_*` tokens on the same actor-override
 * path the REST routes use, so both failure modes apply to them too — and the
 * second one, a service-role read with no tenant predicate, is a cross-tenant
 * leak rather than a degraded feature.
 *
 * Kept as a separate describe rather than folded into the directory walk above:
 * `mcp/tools.ts` is ONE file holding both memory and org handlers, so it cannot
 * be scanned per-file the way the REST handlers are. The assertions are the same
 * two questions asked of a narrower slice.
 */
describe('the MCP org tools pass an actor and scope their raw reads', () => {
  const toolsPath = path.join(repoRoot, 'supabase', 'functions', 'mcp', 'tools.ts');
  const source = readFileSync(toolsPath, 'utf8');

  /** The org half of the file: from the org section marker to end. */
  const orgSection = source.slice(source.indexOf('async function resolveOrgId'));

  it('finds the org section (anti-vacuity)', () => {
    // Every assertion below slices this. A marker rename would otherwise make
    // the whole describe pass by scanning an empty string.
    expect(orgSection.length).toBeGreaterThan(500);
    expect(orgSection).toContain('toolOrgCreate');
    expect(orgSection).toContain('toolOrgDelete');
  });

  it('passes p_actor_user_id to every org RPC it calls', () => {
    const calls = [...orgSection.matchAll(RPC_PATTERN)];
    // Four RPCs: create, rename, delete — plus the pattern also catches none
    // beyond those, so the floor doubles as an anti-vacuity check.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const match of calls) {
      const fn = match[1] as string;
      if (fn in ACTOR_EXEMPT_RPCS) continue;
      const call = sliceCall(orgSection, orgSection.indexOf('(', match.index ?? 0));
      expect(call, `${fn} in mcp/tools.ts must pass p_actor_user_id`).toContain('p_actor_user_id');
    }
  });

  it('narrows every raw org-table read by the caller user_id', () => {
    // `toolOrgList` reads `org_members` and `resolveOrgId` reads through it.
    // On the api_key path the client is service-role, so RLS applies to
    // NEITHER — these predicates are the only tenant boundary. Without them
    // `toolOrgList` returns every membership row in the database and
    // `resolveOrgId` answers for any org whose slug you can guess.
    const rawReads = [...orgSection.matchAll(/\.from\(\s*'(orgs|org_members|org_invites)'\s*\)/g)];
    expect(rawReads.length).toBeGreaterThanOrEqual(2);

    // Each raw read must be followed, within its statement, by a user_id
    // predicate — or be on the JWT-only branch, which is RLS-scoped and says so.
    for (const match of rawReads) {
      const statement = orgSection.slice(match.index ?? 0, (match.index ?? 0) + 600);
      const scoped = /\.eq\('user_id', userId\)/.test(statement)
        || /if \(userId\) query = query\.eq\('user_id', userId\)/.test(statement)
        || /JWT path: unchanged, RLS-scoped/.test(orgSection.slice(Math.max(0, (match.index ?? 0) - 400), match.index ?? 0));
      expect(scoped, `raw read of ${match[1]} in mcp/tools.ts is not narrowed by user_id`).toBe(true);
    }
  });

  it('resolves a slug through membership rather than a bare orgs lookup', () => {
    // The specific hole: `from('orgs').eq('slug', …)` on a service-role client
    // is an existence oracle for any guessable slug, answered BEFORE any RPC
    // can deny. The api_key branch must join through org_members.
    expect(orgSection).toMatch(/\.from\('org_members'\)[\s\S]{0,300}orgs!inner/);
    expect(orgSection).toMatch(/\.eq\('user_id', userId\)[\s\S]{0,200}\.eq\('orgs\.slug', slug\)/);
  });
});
