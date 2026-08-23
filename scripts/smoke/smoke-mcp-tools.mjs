#!/usr/bin/env node
/**
 * Hosted MCP tool-surface conformance smoke.
 *
 * `smoke-mcp-stdio.mjs` proves the CLI's stdio transport can reach a backend;
 * the REST integration specs cover the `memories` / `orgs` HTTP routes. Nothing
 * exercised the HOSTED MCP surface itself — the thing agents actually talk to —
 * beyond a `tools/list` shape check. This does: it drives every op the catalog
 * declares against a live endpoint and asserts the BEHAVIOUR, not just that a
 * response arrived.
 *
 *   node scripts/smoke-mcp-tools.mjs <endpoint> <token>
 *   node scripts/smoke-mcp-tools.mjs "$LOREKIT_MCP_URL" "$LOREKIT_TOKEN"
 *
 * ## Two lanes, and why
 *
 * `--probe` adds a second lane of checks for defects observed on a live
 * deployment. Each is written as an assertion of the CORRECT behaviour and
 * reported as KNOWN rather than failed, so the suite stays green while the
 * defect stands and the script stays the executable record of it. Three
 * outcomes matter:
 *
 *   KNOWN   the defect is still there — expected, exit code unaffected
 *   FIXED    the assertion passed — delete the entry and move the check into
 *            the conformance lane, where a regression will red the build
 *   --strict turn every KNOWN into a failure (use it to gate a fix PR)
 *
 * That is deliberately not `test.skip`: a skipped test proves nothing and rots
 * silently. This one runs, and it tells you the day the behaviour changes.
 *
 * ## Write safety
 *
 * The memory and org lanes WRITE. Every row goes under a per-run scope
 * (`project::smoke-mcp-<runId>`) and every org under a per-run slug, and both
 * are removed in a `finally` — including rows only reachable by id, via the
 * REST route, which is the sole way to clear a row whose scope no
 * scope-addressed path will accept (see the `scope-write-unvalidated` probe).
 * Anything that could not be cleaned is named in the summary.
 *
 * Production is refused unless `--allow-production` is passed, matching the
 * repo's standing rule that the write-heavy smokes run against preview only
 * (`.github/workflows/deploy.yml`).
 *
 * ## Why this is NOT a ci.yml gate
 *
 * It was wired into ci.yml's integration job and reverted, and the reason is
 * worth keeping: on the LOCAL stack there is no credential that gives this
 * suite a usable identity.
 *
 * `mcp-handler.ts` passes `userId: null` to the tools for JWT auth on purpose
 * ("RLS handles scoping"), so a JWT write is a NULL-`user_id` write at the tool
 * layer — the same shape as a service-role write, and therefore the same
 * documented local-only failure the integration job already calls out: the
 * bundled older PostgREST cannot resolve the `UNIQUE NULLS NOT DISTINCT
 * (user_id, scope, key)` upsert arbiter, so the row never lands and every read
 * after it fails. Only an `lk_*` token threads a real user id, and the local
 * stack has no `api_tokens` row to mint one from.
 *
 * So the gate lives on the deploy paths (`deploy.yml`'s smoke-preview and
 * `preview.yml`'s smoke), where `LOREKIT_SMOKE_TOKEN` is a real credential
 * against a real project. Adding a local run would need an `api_tokens` seed
 * step first — the observation above is what makes that a known cost rather
 * than a surprise.
 *
 * ## Expectations come from the catalog
 *
 * The tool set, descriptions and input schemas are read from
 * `packages/cli/src/surfaces.generated.mjs` — the zero-dep view of
 * `packages/schemas/src/shared/tool-catalog.ts`, kept fresh by `gen-surfaces.mjs
 * --check`. So this asserts the live server against the catalog transitively
 * and never against a second hand-maintained list: a hardcoded `EXPECTED_TOOLS`
 * would be exactly the drift the catalog exists to remove.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MCP_TOOL_DEFS, MCP_TOOL_NAMES } from '../../packages/cli/src/surfaces.generated.mjs';

const CLI_BIN = fileURLToPath(new URL('../../packages/cli/bin/lorekit.mjs', import.meta.url));
// A throwaway home-tier store, so a CLI check can never read or write the
// operator's real `~/.lorekit`.
const LOCAL_HOME = mkdtempSync(path.join(tmpdir(), 'lorekit-smoke-'));

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));

const endpoint = positional[0] ?? process.env.LOREKIT_MCP_URL;
const token = positional[1] ?? process.env.LOREKIT_TOKEN;
const PROBE = flags.has('--probe');
const STRICT = flags.has('--strict');
const ALLOW_PRODUCTION = flags.has('--allow-production');

const unknownFlags = [...flags].filter(
  (f) => !['--probe', '--strict', '--allow-production'].includes(f),
);
if (unknownFlags.length) {
  console.error(`error: unknown option(s): ${unknownFlags.join(', ')}`);
  process.exit(2);
}
if (!endpoint || !token) {
  console.error(
    'usage: node scripts/smoke-mcp-tools.mjs <endpoint> <token> [--probe] [--strict] [--allow-production]\n' +
      '  or set LOREKIT_MCP_URL / LOREKIT_TOKEN.\n' +
      '  <endpoint> is the MCP function URL, e.g. https://<ref>.supabase.co/functions/v1/mcp',
  );
  process.exit(2);
}

// The production project ref is static and documented (CLAUDE.md → Endpoints),
// so the guard can name it rather than guessing from a hostname shape.
const PRODUCTION_REF = 'pqokxlhvnosogizsjztg';
if (endpoint.includes(PRODUCTION_REF) && !ALLOW_PRODUCTION) {
  console.error(
    `refusing to run against production (${PRODUCTION_REF}): this suite writes.\n` +
      '  Point it at the preview project, or pass --allow-production if you really mean it.',
  );
  process.exit(2);
}

// REST base for the id-addressed cleanup fallback and the cross-surface probes.
// Only derivable when the endpoint is the conventional `/functions/v1/mcp`;
// otherwise the checks that need it are reported as skipped, never as passed.
const restBase = /\/mcp\/?$/.test(endpoint) ? endpoint.replace(/\/mcp\/?$/, '') : null;

/**
 * Which auth tier the supplied credential belongs to, from the string alone.
 *
 * This decides two things, and getting it wrong is not cosmetic:
 *
 *   · `memory.purge` is an ACCOUNT-WIDE sweep. On the api_key and JWT tiers it
 *     is scoped to one user; on the service tier there is no user to scope it
 *     to, and the preview project is SHARED. So the purge check does not run
 *     there — a smoke test must not be able to destroy another account's
 *     archived lore.
 *   · the `org.*` family is owner-keyed. A service-role caller has no user id
 *     to own anything, so those checks would assert nothing.
 *
 * Anything undecodable is treated as `service` — the conservative end, since
 * that is the tier whose checks are skipped rather than run.
 */
function credentialTier(cred) {
  if (cred.startsWith('lk_')) return 'api_key';
  try {
    const claims = JSON.parse(Buffer.from(cred.split('.')[1], 'base64url').toString('utf8'));
    return claims.role === 'service_role' ? 'service' : 'user';
  } catch {
    return 'service';
  }
}

const TIER = credentialTier(token);
/** Skip a check that needs a caller identity (see `credentialTier`). */
const requireUserScoped = (what) => {
  if (TIER === 'service') skip(`${what} needs a user-scoped credential; this one is service-role`);
};

const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const SCOPE = `project::smoke-mcp-${RUN_ID}`;
const SCOPE_ALT = `repo::lorekit-smoke/${RUN_ID}`;
const ORG_SLUG = `smoke-mcp-${RUN_ID}`;

// ── transport ────────────────────────────────────────────────────────────────

let rpcId = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One JSON-RPC round-trip. `auth: null` sends no Authorization header.
 *
 * A 429 is waited out and retried by default. The suite makes a few hundred
 * calls against a 120/min window, and without this the tail of a run — the
 * CLEANUP most of all — fails on the rate limit and reports every row it wrote
 * as residue. `retryOn429: false` is for the one check that needs to observe a
 * raw 429.
 */
async function rpc(body, { auth = token, retryOn429 = true, attempt = 0 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429 && retryOn429 && attempt < 3) {
    const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 5, 60);
    await sleep((retryAfter + 1) * 1000);
    return rpc(body, { auth, retryOn429, attempt: attempt + 1 });
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _unparsed: text.slice(0, 400) };
  }
  return { status: res.status, headers: res.headers, json };
}

/**
 * `tools/call`, with the tool's own payload unwrapped.
 *
 * Every handler answers with its result JSON-encoded inside
 * `result.content[0].text`, so a caller that reads `result` directly is reading
 * the MCP envelope rather than the tool's answer. Returns
 * `{ ok, value, error, status }`: `ok` false means the call was REFUSED, and
 * `value` is the parsed tool payload otherwise.
 *
 * A refusal arrives in one of TWO shapes, and `ok` folds both together so a
 * check can assert "this was refused" without caring which:
 *
 *   • a JSON-RPC `error` — the call never reached the tool (parse error,
 *     unknown tool/method, an auth or permission denial);
 *   • a SUCCESSFUL result carrying `isError: true` — the tool ran and refused
 *     (a malformed scope, a bad TTL, an oversize value, a memory-cap hit).
 *
 * The second shape is the MCP spec's, so the model can see the failure and
 * self-correct; `mcp-handler.ts` explains the dividing line (dispatch) at
 * length. Reading only `json.error` — as this helper did — reports every
 * tool-originated refusal as a SUCCESS, so each `ok(!r.ok, '… was accepted')`
 * check silently inverts: the harness passes the invalid input, the server
 * correctly rejects it, and the check reports the server accepted it. Eight of
 * them failed that way against preview once the edge adopted the shape.
 * `error.message` carries the tool's own text so the message assertions below
 * (`/use "::"/`, `/65536|64/`, `/unknown_org/`) read one field either way.
 *
 * Same treatment the repo's other MCP clients already give it:
 * `packages/cli/src/shared/mcp.mjs`, `classifyMcpResponse` in
 * `scripts/load-test/load-test-lib.mjs`, and both integration smoke specs.
 */
async function call(name, args = {}) {
  const { status, json } = await rpc({
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  if (json?.error) return { ok: false, error: json.error, status };
  const text = json?.result?.content?.[0]?.text;
  let value = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* a non-JSON body is returned verbatim */
  }
  if (json?.result?.isError) {
    // `code: 'tool_error'` rather than a JSON-RPC number: there is no code on
    // this path, and inventing one would let a check assert a code the wire
    // never carried. `value` rides along for diagnostics — the cleanup ledger
    // prints `r.error ?? r.value`.
    return {
      ok: false,
      toolError: true,
      error: { code: 'tool_error', message: typeof text === 'string' ? text : 'the tool reported an error' },
      value,
      status,
    };
  }
  return { ok: true, value, status };
}

// ── cleanup ledger ───────────────────────────────────────────────────────────

// Keyed by a JSON tuple rather than a joined string: there is no separator to
// pick that a scope or key cannot contain, and no parse step to get wrong.
const writtenKeys = new Map(); // JSON([scope, key]) → { scope, key }
const writtenIds = new Set(); // row ids — cleared by DELETE /memories/:id
const createdOrgs = new Set();
const residue = [];

/** Record a write so the `finally` can undo it, whatever the assertion did. */
function tracked(scope, key, value) {
  writtenKeys.set(JSON.stringify([scope, key]), { scope, key });
  if (value?.id) writtenIds.add(value.id);
  return value;
}

async function write(scope, key, args = {}) {
  const r = await call('memory.write', { scope, key, value: 'smoke body', ...args });
  if (r.ok) tracked(scope, key, r.value);
  return r;
}

async function cleanup() {
  for (const { scope, key } of writtenKeys.values()) {
    const r = await call('memory.delete', { scope, key, force: true });
    if (r.ok && r.value?.deleted === true) continue;
    // `deleted: false` also covers "a check already removed it", so confirm
    // absence rather than inferring residue from the delete's own answer —
    // otherwise every row a check destroys on purpose is reported as left behind.
    const gone = await call('memory.read', { scope, key });
    if (!gone.ok || gone.value !== null) residue.push(`memory ${scope}::${key}`);
  }
  // Rows whose scope no scope-addressed path accepts are only reachable by id.
  if (restBase) {
    for (const id of writtenIds) {
      try {
        const res = await fetch(`${restBase}/memories/${id}?force=true`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20_000),
        });
        // 404 is the expected answer for a row the scope path already removed.
        if (res.status !== 204 && res.status !== 404) residue.push(`memory id=${id} (http ${res.status})`);
      } catch (err) {
        residue.push(`memory id=${id} (${err.name})`);
      }
    }
  } else if (writtenIds.size) {
    residue.push(`${writtenIds.size} row(s) not id-cleanable — no REST base derivable from the endpoint`);
  }
  for (const slug of createdOrgs) {
    const r = await call('org.delete', { slug });
    // Orgs soft-delete and there is no purge on either public surface, so even a
    // successful delete leaves a row behind. Say so rather than implying it is
    // gone. A `not found` here means a check already deleted it — same outcome.
    const deleted = (r.ok && r.value?.deleted === true) || /not found/i.test(r.error?.message ?? '');
    residue.push(
      deleted
        ? `org ${slug} (soft-deleted — no purge exists on MCP or REST)`
        : `org ${slug} (delete failed: ${r.error?.message ?? JSON.stringify(r.value)})`,
    );
  }
}

// ── harness ──────────────────────────────────────────────────────────────────

const results = { pass: 0, fail: 0, known: 0, fixed: 0, skip: 0 };
const failures = [];
const cases = [];

/** A behaviour that holds today. A failure here is a regression. */
const check = (name, fn) => cases.push({ name, fn, lane: 'conformance' });

/**
 * A behaviour that SHOULD hold and does not. `id` is the defect's slug, used in
 * the output and in the write-up. Only runs under `--probe`.
 */
const known = (id, name, fn) => cases.push({ name, fn, lane: 'known', id });

class Skip extends Error {}
const skip = (why) => {
  throw new Skip(why);
};

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}
function ok(condition, what) {
  if (!condition) throw new Error(what);
}

async function run() {
  for (const c of cases) {
    if (c.lane === 'known' && !PROBE) continue;
    let outcome;
    try {
      await c.fn();
      outcome = 'pass';
    } catch (err) {
      outcome = err instanceof Skip ? 'skip' : 'fail';
      var reason = err.message;
    }

    if (c.lane === 'conformance') {
      if (outcome === 'pass') {
        results.pass++;
        console.log(`  ✓ ${c.name}`);
      } else if (outcome === 'skip') {
        results.skip++;
        console.log(`  – ${c.name} — skipped: ${reason}`);
      } else {
        results.fail++;
        failures.push(`${c.name}: ${reason}`);
        console.log(`  ✗ ${c.name}\n      ${reason}`);
      }
      continue;
    }

    // Known-defect lane: a PASS is the interesting outcome.
    if (outcome === 'pass') {
      results.fixed++;
      console.log(`  ★ FIXED [${c.id}] ${c.name} — promote this to the conformance lane`);
    } else if (outcome === 'skip') {
      results.skip++;
      console.log(`  – [${c.id}] ${c.name} — skipped: ${reason}`);
    } else if (STRICT) {
      results.fail++;
      failures.push(`[${c.id}] ${c.name}: ${reason}`);
      console.log(`  ✗ [${c.id}] ${c.name}\n      ${reason}`);
    } else {
      results.known++;
      console.log(`  ! KNOWN [${c.id}] ${c.name}\n      ${reason}`);
    }
  }
}

// ── 1. transport + auth ──────────────────────────────────────────────────────

check('initialize negotiates protocol 2024-11-05', async () => {
  const { json } = await rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: {} });
  eq(json.result?.protocolVersion, '2024-11-05', 'protocolVersion');
  eq(json.result?.serverInfo?.name, 'lorekit', 'serverInfo.name');
});

check('a missing token is refused in-band (-32001, HTTP 200)', async () => {
  const { status, json } = await rpc(
    { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' },
    { auth: null },
  );
  // HTTP 200 is deliberate: a 401 stalls streamable-HTTP clients, which have no
  // OAuth flow here to drive (mcp/index.ts).
  eq(status, 200, 'http status');
  eq(json.error?.code, -32001, 'error code');
});

check('an unknown token is refused, and cannot read', async () => {
  const { json } = await rpc(
    { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'memory.scopes', arguments: {} } },
    { auth: 'lk_rw_000000000000000000000000000000' },
  );
  eq(json.error?.code, -32001, 'error code');
  ok(!json.result, 'a refused call must not carry a result');
});

check('GET answers 405 with Allow: POST', async () => {
  const res = await fetch(endpoint, { method: 'GET', signal: AbortSignal.timeout(20_000) });
  eq(res.status, 405, 'http status');
  eq(res.headers.get('allow'), 'POST', 'Allow header');
});

check('an unknown method is -32601', async () => {
  const { json } = await rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'resources/list' });
  eq(json.error?.code, -32601, 'error code');
});

check('an unknown tool is -32601', async () => {
  const r = await call('memory.frobnicate');
  eq(r.error?.code, -32601, 'error code');
});

// ── 2. tools/list is the catalog ─────────────────────────────────────────────

let liveTools = null;

check('tools/list serves exactly the catalog ops, in catalog order', async () => {
  const { json } = await rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' });
  liveTools = json.result?.tools;
  ok(Array.isArray(liveTools), 'tools/list did not return an array');
  eq(liveTools.map((t) => t.name), MCP_TOOL_NAMES, 'advertised op names');
});

check('every advertised description and schema matches the catalog', async () => {
  ok(liveTools, 'tools/list did not run');
  const byName = new Map(liveTools.map((t) => [t.name, t]));
  for (const expected of MCP_TOOL_DEFS) {
    const live = byName.get(expected.name);
    ok(live, `${expected.name} is missing from tools/list`);
    eq(live.description, expected.description, `${expected.name} description`);
    eq(live.inputSchema, expected.inputSchema, `${expected.name} inputSchema`);
  }
});

check('every advertised property carries a description', async () => {
  ok(liveTools, 'tools/list did not run');
  const bare = [];
  for (const tool of liveTools) {
    for (const [prop, schema] of Object.entries(tool.inputSchema?.properties ?? {})) {
      if (!schema.description) bare.push(`${tool.name}.${prop}`);
    }
  }
  eq(bare, [], 'properties with no description');
});

// ── 3. the memory lifecycle ──────────────────────────────────────────────────

check('write → read round-trips the value', async () => {
  const w = await write(SCOPE, 'lifecycle', { value: 'first body' });
  ok(w.ok && w.value?.id, `write failed: ${JSON.stringify(w.error ?? w.value)}`);
  const r = await call('memory.read', { scope: SCOPE, key: 'lifecycle' });
  eq(r.value?.value, 'first body', 'read value');
});

check('a second write to the same key updates in place', async () => {
  const w = await write(SCOPE, 'lifecycle', { value: 'second body' });
  ok(w.ok, 'second write failed');
  const r = await call('memory.read', { scope: SCOPE, key: 'lifecycle' });
  eq(r.value?.value, 'second body', 'read value after update');
});

check('a read miss answers null, not an error', async () => {
  const r = await call('memory.read', { scope: SCOPE, key: 'no-such-key' });
  ok(r.ok, 'a miss must not be a JSON-RPC error');
  eq(r.value, null, 'miss payload');
});

check('ttl_days sets an expiry; clear_ttl removes it', async () => {
  const w = await write(SCOPE, 'ttl', { ttl_days: 5 });
  ok(w.value?.expires_at, 'expires_at was not set');
  const cleared = await write(SCOPE, 'ttl', { clear_ttl: true });
  ok(cleared.ok, 'clear_ttl write failed');
  eq(cleared.value?.expires_at ?? null, null, 'expires_at after clear_ttl');
});

check('created_at backdates the row (the `migrate` case)', async () => {
  const w = await write(SCOPE, 'backdated', { created_at: '2020-01-02T03:04:05.000Z' });
  ok(w.value?.created_at?.startsWith('2020-01-02'), `created_at: ${w.value?.created_at}`);
});

check('a future created_at is refused', async () => {
  const r = await call('memory.write', {
    scope: SCOPE,
    key: 'future',
    value: 'v',
    created_at: '2099-01-01T00:00:00Z',
  });
  ok(!r.ok, 'a future created_at was accepted');
});

check('scope normalisation lowercases on write', async () => {
  const mixed = `PROJECT::Smoke-MCP-${RUN_ID}-Case`;
  const lowered = mixed.toLowerCase();
  const w = await call('memory.write', { scope: mixed, key: 'cased', value: 'v' });
  ok(w.ok, `mixed-case write failed: ${JSON.stringify(w.error)}`);
  tracked(lowered, 'cased', w.value);
  const r = await call('memory.list', { scope: lowered });
  eq(r.value?.entries?.map((e) => e.key), ['cased'], 'entries under the lowercased scope');
});

check('a single-colon scope is refused on write', async () => {
  const r = await call('memory.write', { scope: 'project:single', key: 'k', value: 'v' });
  ok(!r.ok, 'a single-colon scope was accepted');
  ok(/use "::"/.test(r.error?.message ?? ''), `unexpected message: ${r.error?.message}`);
});

check('an unknown scope prefix is refused', async () => {
  const r = await call('memory.list', { scope: 'team::whatever' });
  ok(!r.ok, 'an unknown scope prefix was accepted');
});

check('a value over 64 KB is refused', async () => {
  const r = await call('memory.write', { scope: SCOPE, key: 'oversize', value: 'x'.repeat(70 * 1024) });
  ok(!r.ok, 'an oversize value was accepted');
  ok(/65536|64/.test(r.error?.message ?? ''), `unexpected message: ${r.error?.message}`);
});

check('list filters by tag (OR), kind and host', async () => {
  await write(SCOPE, 'tagged', { tags: ['smoke::a'], kind: 'lesson', host: 'smoke' });
  await write(SCOPE, 'bussed', { kind: 'bus', host: 'smoke' });
  const byTag = await call('memory.list', { scope: SCOPE, tags: ['smoke::a', 'absent'] });
  ok(
    byTag.value?.entries?.some((e) => e.key === 'tagged'),
    'the tag filter did not match on ANY of the supplied labels',
  );
  const byKind = await call('memory.list', { scope: SCOPE, kind: 'bus' });
  eq(byKind.value?.entries?.map((e) => e.key), ['bussed'], 'kind=bus entries');
  const byHost = await call('memory.list', { scope: SCOPE, kind: 'lesson', host: 'smoke' });
  eq(byHost.value?.entries?.map((e) => e.key), ['tagged'], 'kind=lesson host=smoke entries');
});

check('view: summary drops the value and reports its size', async () => {
  const r = await call('memory.list', { scope: SCOPE, view: 'summary', limit: 100 });
  const entry = r.value?.entries?.find((e) => e.key === 'lifecycle');
  ok(entry, 'the lifecycle entry is missing');
  eq(entry.value, undefined, 'summary entries must carry no value');
  eq(entry.value_bytes, Buffer.byteLength('second body'), 'value_bytes');
  eq(entry.preview, 'second body', 'preview');
});

check('the cursor walks every page exactly once', async () => {
  const seen = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const r = await call('memory.list', { scope: SCOPE, limit: 2, ...(cursor ? { cursor } : {}) });
    ok(r.ok, `page ${page} failed: ${JSON.stringify(r.error)}`);
    seen.push(...r.value.entries.map((e) => e.key));
    if (!r.value.hasMore) break;
    cursor = r.value.nextCursor;
    ok(cursor, 'hasMore was true with no nextCursor');
  }
  eq(new Set(seen).size, seen.length, `a key was served twice: ${seen.join(', ')}`);
  const all = await call('memory.list', { scope: SCOPE, limit: 100 });
  eq(seen.length, all.value.entries.length, 'paged total vs single-page total');
});

check('order: rank returns one bounded page with no cursor', async () => {
  const r = await call('memory.list', { scope: SCOPE, order: 'rank' });
  eq(r.value?.hasMore, false, 'ranked hasMore');
  eq(r.value?.nextCursor, null, 'ranked nextCursor');
});

check('search finds a body across scopes', async () => {
  await write(SCOPE_ALT, 'searchable', { value: 'a distinctive smoke phrase' });
  const r = await call('memory.search', { q: 'distinctive' });
  ok(
    r.value?.entries?.some((e) => e.key === 'searchable'),
    'search did not find the row it just wrote',
  );
});

check('search accepts an owner wildcard — and only search does', async () => {
  const [prefix] = SCOPE_ALT.split('/');
  const hit = await call('memory.search', { q: 'distinctive', scopes: [`${prefix}/*`] });
  ok(hit.value?.entries?.length >= 1, 'the owner wildcard matched nothing');
  const refused = await call('memory.list', { scope: `${prefix}/*` });
  ok(!refused.ok, 'memory.list accepted a wildcard scope');
});

check('archive hides a row from reads but keeps it listable and restorable', async () => {
  await write(SCOPE, 'archivable');
  const a = await call('memory.archive', { scope: SCOPE, key: 'archivable' });
  eq(a.value?.archived, true, 'archive result');
  eq((await call('memory.read', { scope: SCOPE, key: 'archivable' })).value, null, 'read after archive');
  const listed = await call('memory.list', { scope: SCOPE, limit: 100 });
  ok(
    !listed.value.entries.some((e) => e.key === 'archivable'),
    'an archived row is still in memory.list',
  );
  const archived = await call('memory.list_archived', { scope: SCOPE });
  ok(
    archived.value?.entries?.some((e) => e.key === 'archivable'),
    'an archived row is not in memory.list_archived',
  );
  eq((await call('memory.restore', { scope: SCOPE, key: 'archivable' })).value?.restored, true, 'restore');
  ok(
    (await call('memory.read', { scope: SCOPE, key: 'archivable' })).value?.value,
    'the row did not come back after restore',
  );
});

check('restoring a row that is not archived reports not_found, not success', async () => {
  const r = await call('memory.restore', { scope: SCOPE, key: 'archivable' });
  eq(r.value?.restored, false, 'restored');
  eq(r.value?.reason, 'not_found', 'reason');
});

check('delete soft-archives by default and destroys with force', async () => {
  await write(SCOPE, 'deletable');
  const soft = await call('memory.delete', { scope: SCOPE, key: 'deletable' });
  eq(soft.value, { deleted: false, archived: true }, 'soft delete result');
  const hard = await call('memory.delete', { scope: SCOPE, key: 'deletable', force: true });
  eq(hard.value, { deleted: true, archived: false }, 'force delete result');
  const archived = await call('memory.list_archived', { scope: SCOPE });
  ok(
    !archived.value.entries.some((e) => e.key === 'deletable'),
    'a force-deleted row is still archived',
  );
});

check('scopes reports each scope this run wrote, with counts', async () => {
  const r = await call('memory.scopes');
  const byScope = new Map((r.value?.scopes ?? []).map((s) => [s.scope, s]));
  for (const scope of [SCOPE, SCOPE_ALT]) {
    ok(byScope.has(scope), `${scope} is missing from the inventory`);
    ok(byScope.get(scope).count > 0, `${scope} reports a zero count`);
  }
});

check('purge and purge_expired answer with a count', async () => {
  requireUserScoped('an account-wide purge');
  const purged = await call('memory.purge', { retention_days: 365 });
  ok(Number.isInteger(purged.value?.purged), `purge: ${JSON.stringify(purged.value ?? purged.error)}`);
  const expired = await call('memory.purge_expired');
  ok(Number.isInteger(expired.value?.purged), `purge_expired: ${JSON.stringify(expired.value ?? expired.error)}`);
});

check('a missing required argument is refused', async () => {
  ok(!(await call('memory.write', { scope: SCOPE, value: 'no key' })).ok, 'write without key');
  ok(!(await call('memory.read', { key: 'no scope' })).ok, 'read without scope');
  ok(!(await call('memory.search', { q: '' })).ok, 'search with an empty q');
});

check('ttl_days outside 1–365 is refused', async () => {
  ok(!(await call('memory.write', { scope: SCOPE, key: 'ttl-hi', value: 'v', ttl_days: 999 })).ok, 'ttl_days 999');
  ok(!(await call('memory.write', { scope: SCOPE, key: 'ttl-lo', value: 'v', ttl_days: 0 })).ok, 'ttl_days 0');
});

check('an invalid kind is refused', async () => {
  ok(!(await call('memory.list', { scope: SCOPE, kind: 'nonsense' })).ok, 'kind=nonsense');
});

// The SHAPE of the refusals above, asserted on the raw envelope rather than
// through `call()` — which folds both refusal shapes into `ok: false` and so
// would pass whichever one the server sent. A caller mistake is a tool-
// originated failure: it comes back as a SUCCESSFUL result carrying
// `isError: true`, so the model can read the reason and self-correct, not as a
// JSON-RPC error a client library may swallow before the model ever sees it.
// Dispatch is the dividing line (mcp-handler.ts), so an unknown TOOL stays a
// protocol error — the check above already pins that end.
check('a caller mistake is an isError result, not a JSON-RPC error', async () => {
  const { status, json } = await rpc({
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: { name: 'memory.write', arguments: { scope: 'project:single', key: 'k', value: 'v' } },
  });
  eq(status, 200, 'http status');
  ok(!json?.error, `a caller mistake must not be a JSON-RPC error: ${JSON.stringify(json?.error)}`);
  eq(json?.result?.isError, true, 'result.isError');
  ok(/use "::"/.test(json?.result?.content?.[0]?.text ?? ''), 'the refusal carries the reason the model needs');
});

// ── 4. org.* over an API token (opened by #517) ──────────────────────────────

check('org.create makes the caller owner and org.list reports the role', async () => {
  requireUserScoped('org ownership');
  const c = await call('org.create', { slug: ORG_SLUG, name: 'Smoke MCP' });
  ok(c.ok && c.value?.slug === ORG_SLUG, `org.create failed: ${JSON.stringify(c.error ?? c.value)}`);
  createdOrgs.add(ORG_SLUG);
  const list = await call('org.list');
  const mine = list.value?.entries?.find((e) => e.slug === ORG_SLUG);
  ok(mine, 'the new org is missing from org.list');
  eq(mine.role, 'owner', 'role');
});

check('org.rename changes the display name', async () => {
  requireUserScoped('org ownership');
  const r = await call('org.rename', { slug: ORG_SLUG, name: 'Smoke MCP renamed' });
  ok(r.ok, `org.rename failed: ${JSON.stringify(r.error)}`);
  const list = await call('org.list');
  eq(
    list.value?.entries?.find((e) => e.slug === ORG_SLUG)?.name,
    'Smoke MCP renamed',
    'name after rename',
  );
});

check('a slug the caller cannot see is "not found", never a permission error', async () => {
  requireUserScoped('org membership');
  // The same answer for a non-member org and a non-existent one is what keeps
  // the tool from becoming an existence oracle over the whole slug namespace.
  for (const slug of ['test', 'acme', 'lorekit', `absent-${RUN_ID}`]) {
    const r = await call('org.rename', { slug, name: 'nope' });
    ok(!r.ok, `org.rename succeeded on ${slug}`);
    ok(
      /not found/i.test(r.error?.message ?? ''),
      `${slug}: expected a not-found message, got ${r.error?.message}`,
    );
  }
});

check('an org-owned write lands, and archive/restore/force-delete work on it', async () => {
  requireUserScoped('org ownership');
  const w = await call('memory.write', {
    scope: SCOPE,
    key: 'org-owned',
    value: 'org body',
    org: ORG_SLUG,
  });
  ok(w.ok, `org-owned write failed: ${JSON.stringify(w.error)}`);
  tracked(SCOPE, 'org-owned', w.value);
  const soft = await call('memory.delete', { scope: SCOPE, key: 'org-owned', org: ORG_SLUG });
  eq(soft.value, { deleted: false, archived: true }, 'org-owned soft delete');
  eq((await call('memory.restore', { scope: SCOPE, key: 'org-owned' })).value?.restored, true, 'restore');
  const hard = await call('memory.delete', { scope: SCOPE, key: 'org-owned', org: ORG_SLUG, force: true });
  eq(hard.value, { deleted: true, archived: false }, 'org-owned force delete');
});

check('a write naming an org the caller is not in is refused as unknown_org', async () => {
  requireUserScoped('org membership');
  const r = await call('memory.write', { scope: SCOPE, key: 'foreign-org', value: 'v', org: 'test' });
  ok(!r.ok, 'a write to a foreign org was accepted');
  ok(/unknown_org/.test(r.error?.message ?? ''), `unexpected message: ${r.error?.message}`);
});

check('a soft-deleted org stops accepting writes, renames and deletes', async () => {
  requireUserScoped('org ownership');
  const slug = `${ORG_SLUG}-transient`;
  const c = await call('org.create', { slug, name: 'Transient' });
  ok(c.ok, `org.create failed: ${JSON.stringify(c.error)}`);
  createdOrgs.add(slug);
  eq((await call('org.delete', { slug })).value?.deleted, true, 'delete');
  ok(!(await call('org.rename', { slug, name: 'zombie' })).ok, 'rename after delete');
  ok(!(await call('org.delete', { slug })).ok, 'delete after delete');
  ok(!(await call('memory.write', { scope: SCOPE, key: 'dead-org', value: 'v', org: slug })).ok, 'write after delete');
});

// ── 5. known defects, observed live (run with --probe) ───────────────────────

known(
  'org-list-shows-soft-deleted',
  'org.list hides a soft-deleted org',
  async () => {
    // On the api_key path the client is service-role, so the two RLS predicates
    // the JWT path relied on are gone. `toolOrgList` restored the `user_id` one
    // and not `deleted_at is null` (mcp/tools.ts), so a deleted org stays in the
    // list forever — it cannot be renamed, deleted again, or recreated (the slug
    // unique index still holds it) and no purge exists on either public surface.
    // `handleListOrgs` (orgs/handlers/orgs/list.ts) has the same gap.
    requireUserScoped('org ownership');
    const slug = `${ORG_SLUG}-listcheck`;
    ok((await call('org.create', { slug, name: 'List check' })).ok, 'org.create failed');
    createdOrgs.add(slug);
    ok((await call('org.delete', { slug })).ok, 'org.delete failed');
    const list = await call('org.list');
    ok(
      !list.value?.entries?.some((e) => e.slug === slug),
      'a soft-deleted org is still listed by org.list',
    );
  },
);

known(
  'org-create-skips-slug-validation',
  'org.create refuses a slug REST would refuse',
  async () => {
    // REST runs `validateSlug` and answers 400; MCP runs none, so an org can be
    // created through MCP that the REST routes then refuse to manage at all.
    requireUserScoped('org ownership');
    const slug = `smoke mcp ${RUN_ID}`;
    const r = await call('org.create', { slug, name: 'Spaced slug' });
    if (r.ok) createdOrgs.add(slug);
    ok(!r.ok, `org.create accepted the slug "${slug}"`);
  },
);

known(
  'scope-write-unvalidated-on-rest',
  'REST POST /memories validates the scope it stores',
  async () => {
    // `CreateMemoryBodySchema` swaps the validating/normalising `ScopeSchema`
    // for `RawScopeSchema` (packages/schemas/src/domain/memory.ts), and create.ts adds
    // no check of its own. So a non-canonical scope is stored, shows up in
    // memory.scopes, and is then unreachable: every scope-addressed read and
    // delete on BOTH surfaces refuses the string. Only DELETE /memories/:id
    // clears it — and MCP has no id-addressed op. The CLI's remote store writes
    // through this route, so `lorekit write` and the hooks inherit it.
    if (!restBase) skip('no REST base derivable from the endpoint');
    const scope = `project:smoke-unvalidated-${RUN_ID}`;
    const res = await fetch(`${restBase}/memories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, key: 'k', value: 'stranded row' }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 201 && body.id) writtenIds.add(body.id); // id-only cleanup
    ok(res.status >= 400, `REST stored a single-colon scope (http ${res.status})`);
  },
);

known(
  'search-tags-documented-and-is-or',
  'memory.search filters tags with AND, as its schema says',
  async () => {
    // The catalog describes search's `tags` as "ALL of these labels (AND)" while
    // both surfaces use `.overlaps` — OR. The description is what agents read,
    // and it is generated into llms.txt and the docs.
    await write(SCOPE, 'tag-and', { value: 'tag and probe', tags: ['smoke::present'] });
    const r = await call('memory.search', { q: 'probe', tags: ['smoke::present', `absent-${RUN_ID}`] });
    ok(
      !r.value?.entries?.some((e) => e.key === 'tag-and'),
      'a row matching only ONE of the supplied tags came back from an AND filter',
    );
  },
);

known('purge-unusable-on-the-jwt-tier', 'purge works for a dashboard-session caller', async () => {
  // `tools/list` advertises `memory.purge` to every caller, but the JWT tier
  // reaches `if (!userId) throw new Error('memory.purge requires a user_id')`
  // (mcp/tools.ts) every time: `mcp-handler.ts` passes `userId: null` for JWT
  // auth by design, so the two purge tools are unreachable from a dashboard
  // session while working for an `lk_*` token. Observed on the local stack in
  // CI; only a JWT run can see it, so the check states its own blindness rather
  // than passing vacuously on an API token.
  if (TIER !== 'user') skip('only a JWT caller reaches the null-userId path');
  const r = await call('memory.purge', { retention_days: 365 });
  ok(r.ok, `purge refused a JWT caller: ${JSON.stringify(r.error)}`);
});

known('key-length-unenforced', 'a key over the advertised 512 characters is refused', async () => {
  const key = 'k'.repeat(513);
  const r = await call('memory.write', { scope: SCOPE, key, value: 'v' });
  if (r.ok) tracked(SCOPE, key, r.value);
  ok(!r.ok, 'a 513-character key was accepted, though the schema advertises max 512');
});

known('limit-max-unenforced', 'a limit over the advertised maximum of 100 is refused', async () => {
  const r = await call('memory.list', { scope: SCOPE, limit: 500 });
  ok(!r.ok, 'limit=500 was accepted, though the schema advertises maximum 100');
});

known('negative-limit-leaks-db-error', 'a negative limit is a validation error, not a DB error', async () => {
  const r = await call('memory.list', { scope: SCOPE, limit: -5 });
  ok(!r.ok, 'limit=-5 was accepted');
  ok(
    !/range not satisfiable/i.test(r.error?.message ?? ''),
    `the raw PostgREST message reached the client: ${r.error?.message}`,
  );
});

known('unknown-arguments-ignored', 'an unknown tool argument is refused, not ignored', async () => {
  // The CLI rejects an unknown FLAG (#517 closed the last gap, `bootstrap`); the
  // MCP schemas have no `additionalProperties: false`, so a typo is silently
  // dropped: `ttl` for `ttl_days` writes a permanent memory and reports success.
  const r = await call('memory.write', { scope: SCOPE, key: 'typo-arg', value: 'v', ttl: 3 });
  if (r.ok) {
    tracked(SCOPE, 'typo-arg', r.value);
    ok(r.value?.expires_at, 'the typo\'d `ttl` was accepted AND silently dropped');
  }
  ok(!r.ok, 'an unknown argument was accepted');
});

known('rate-limit-response-has-null-id', 'a 429 echoes the request id', async () => {
  // The auth-failure path peeks the id precisely because an `id: null` body
  // "can't be matched to the pending tools/call and also hangs" (mcp/index.ts);
  // the rate-limit path returns exactly that shape. Costs ~150 parallel calls.
  const burst = await Promise.all(
    Array.from({ length: 150 }, (_, i) =>
      rpc(
        { jsonrpc: '2.0', id: 900_000 + i, method: 'tools/call', params: { name: 'memory.scopes', arguments: {} } },
        { retryOn429: false },
      ).catch(() => null),
    ),
  );
  const limited = burst.find((r) => r?.status === 429);
  if (!limited) skip('the rate limit did not engage — nothing to assert');
  ok(limited.json?.id !== null && limited.json?.id !== undefined, 'the 429 body carries id: null');
});

// ── 6. the CLI against the same backend ──────────────────────────────────────
//
// `surface-parity.test.mjs` gates the CLI's surface STATICALLY — which command
// exists, which op it binds to, what the stdio server dispatches. What no test
// covers is what those commands DO against a live backend, which is where the
// two checks below live.

/** Run the CLI and capture its output. Never throws on a non-zero exit. */
function cli(args, env = {}) {
  const res = spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      ...process.env,
      // The ambient LOREKIT_TOKEN / LOREKIT_MCP_URL point wherever the operator's
      // shell points — production, usually. Clear both so a check can only reach
      // the endpoint it was given explicitly.
      LOREKIT_TOKEN: '',
      LOREKIT_MCP_URL: '',
      LOREKIT_HOME: LOCAL_HOME,
      ...env,
    },
  });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

check('the CLI reads back a row written over MCP', async () => {
  await write(SCOPE, 'cli-visible', { value: 'written over MCP, read over the CLI' });
  const { out } = cli(['list', '--scope', SCOPE, '--endpoint', endpoint, '--token', token]);
  ok(/Remote/.test(out), `no Remote section in the output:\n${out}`);
  ok(out.includes('cli-visible'), `the row is missing from the listing:\n${out}`);
});

known('lint-false-green-on-remote-failure', 'lint fails loudly when the remote read fails', async () => {
  // `lint` is documented as a CI gate ("Exits non-zero when issues are found").
  // When the remote read FAILS it reports "no lint issues" and exits 0, so a
  // rotated token turns the gate green. `list`, on the same failure, prints
  // `! Authentication required` — so the store surfaces it and lint drops it.
  const { code, out } = cli([
    'lint', '--scope', SCOPE,
    '--endpoint', endpoint,
    '--token', 'lk_rw_000000000000000000000000000000',
  ]);
  const remoteSection = out.slice(out.indexOf('Remote')).split('\n').slice(0, 3).join(' | ').trim();
  ok(
    !/no lint issues/.test(out) || code !== 0,
    `lint exited ${code} reporting no issues, though the remote read failed — ${remoteSection}`,
  );
});

known('stdio-list-has-no-archived-filter', 'the stdio server can reach archived rows', async () => {
  // `memory.list_archived` is exempt from the CLI's stdio server because it is
  // "reachable through memory.list's archived filter on the offline store"
  // (LOCAL_MCP_EXEMPT, surfaces.generated.mjs). `memory.list` advertises no
  // `archived` property and silently ignores one, so an agent on that server can
  // archive a lesson and has no way to enumerate what it archived.
  const scope = 'project::stdio-archived-probe';
  const send = (calls) => {
    const lines = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })];
    calls.forEach((params, i) =>
      lines.push(JSON.stringify({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params })),
    );
    const res = spawnSync(process.execPath, [CLI_BIN, 'mcp'], {
      encoding: 'utf8',
      input: `${lines.join('\n')}\n`,
      timeout: 90_000,
      env: { ...process.env, LOREKIT_TOKEN: '', LOREKIT_MCP_URL: '', LOREKIT_HOME: LOCAL_HOME, LOREKIT_MODE: 'local' },
    });
    return (res.stdout ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  };

  const replies = send([
    { name: 'memory.write', arguments: { scope, key: 'hidden', value: 'archived body' } },
    { name: 'memory.archive', arguments: { scope, key: 'hidden' } },
    { name: 'memory.list', arguments: { scope, archived: true } },
  ]);
  const listed = replies.find((r) => r.id === 4);
  let payload = null;
  try {
    payload = JSON.parse(listed?.result?.content?.[0]?.text ?? 'null');
  } catch {
    /* left null — asserted below */
  }
  ok(
    payload?.entries?.some((e) => e.key === 'hidden'),
    'memory.list {archived: true} did not return the archived row, and memory.list_archived is not dispatched',
  );
});

// ── main ─────────────────────────────────────────────────────────────────────

console.log(`MCP tool smoke → ${endpoint}`);
console.log(`  run id ${RUN_ID} · scopes ${SCOPE}, ${SCOPE_ALT} · org ${ORG_SLUG}`);
console.log(`  lanes: conformance${PROBE ? ` + known defects${STRICT ? ' (strict)' : ''}` : ''}`);
// Naming the tier is not decoration: it decides which checks run, and only an
// `lk_*` credential exercises the property that org tools serve API tokens at
// all — the JWT tier passes those checks on any build, so a green run there is
// not evidence for that half.
console.log(
  `  credential: ${TIER}${TIER === 'service' ? ' — org and purge checks will skip' : ''}` +
    `${TIER === 'user' ? ' — org checks pass on a JWT regardless of the API-token gate' : ''}\n`,
);

let crashed = null;
try {
  await run();
} catch (err) {
  crashed = err;
} finally {
  process.stdout.write('\ncleaning up… ');
  try {
    await cleanup();
    console.log('done');
  } catch (err) {
    console.log(`incomplete: ${err.message}`);
  }
}

console.log(
  `\n${results.pass} passed · ${results.fail} failed · ${results.known} known · ` +
    `${results.fixed} fixed · ${results.skip} skipped`,
);
if (residue.length) {
  console.log('\nleft behind (delete by hand if it matters):');
  for (const item of residue) console.log(`  · ${item}`);
}
if (results.fixed) {
  console.log('\nA known defect now passes. Move it into the conformance lane so a regression reds the build.');
}
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
}
if (crashed) {
  console.error(`\nthe run itself failed: ${crashed.stack ?? crashed.message}`);
  process.exit(1);
}
process.exit(failures.length ? 1 : 0);
