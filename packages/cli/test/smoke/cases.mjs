// The CLI smoke cases — one scripted session per lane that runs the REAL
// `lorekit` binary for every command it ships.
//
//   offline  a throwaway HOME + project, LOREKIT_MODE=local, no network. Runs on
//            every PR inside `cli:test` (test/cli-smoke.test.mjs).
//   remote   the same binary against a live endpoint + token (the preview
//            deploy). Writes only under the run's own project scope and
//            hard-deletes what it wrote (run.mjs). Refuses production.
//
// ## Adding a command
//
// `cli-smoke.test.mjs` fails when a command in `src/commands.mjs` has no case
// here and no entry in NOT_SMOKED. Add a `smoke('<command>', '<what it proves>',
// [lanes], async ({ cli, ctx }) => { ... })` below, in session order. Assert on
// behaviour (what changed, what came back), not just "exit 0".
//
// Cases run in order and may build on each other (a lesson written early is
// read later) — the session is the realistic shape, and every assertion names
// the exact command that broke.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { LOCAL_MCP_EXEMPT, MCP_TOOL_NAMES } from '../../src/surfaces.generated.mjs';
import { runMcp, trackRemoteWrite } from './harness.mjs';

/** @typedef {'offline' | 'remote'} Lane */

/** @type {{ command: string, name: string, lanes: Lane[], fn: Function }[]} */
export const CASES = [];

/**
 * Commands with no smoke case, and why. A declared exemption, so a gap is a
 * reviewable decision rather than an oversight. Empty today — keep it that way.
 * @type {Record<string, string>}
 */
export const NOT_SMOKED = {};

/** Register a case. `command` is the canonical name from src/commands.mjs (aliases are credited to it). */
function smoke(command, name, lanes, fn) {
  CASES.push({ command, name, lanes, fn });
}

const OFFLINE = /** @type {Lane[]} */ (['offline']);
const REMOTE = /** @type {Lane[]} */ (['remote']);
const BOTH = /** @type {Lane[]} */ (['offline', 'remote']);

/** The tools the local stdio server should advertise: the catalog minus its declared exemptions. */
export const LOCAL_MCP_TOOLS = MCP_TOOL_NAMES.filter((t) => !(t in LOCAL_MCP_EXEMPT));

/** The tools the offline `mcp` case calls — the coverage guard checks this against LOCAL_MCP_TOOLS. */
export const LOCAL_MCP_CALLED = [
  'memory.write',
  'memory.read',
  'memory.list',
  'memory.search',
  'memory.scopes',
  'memory.archive',
  'memory.restore',
  'memory.delete',
  'org.create',
  'org.list',
  'org.rename',
  'org.delete',
];

// ── helpers ──────────────────────────────────────────────────────────────────

/** The store block a lane reads back from: `offline` locally, `remote` against an endpoint. */
const storeOf = (ctx) => (ctx.lane === 'remote' ? 'remote' : 'offline');

/** Every `key` under a JSON block, however the command groups its entries. */
function keysIn(value) {
  const keys = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.key === 'string') keys.push(v.key);
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return [...new Set(keys)];
}

const alphaValue = (ctx) => `The CLI smoke suite wrote this lesson — marker zebra-${ctx.runId}.`;

/** Write through the CLI and record it for the remote lane's cleanup. */
function writeLesson(cli, ctx, name, value, extra = []) {
  const key = ctx.key(name);
  trackRemoteWrite(ctx, ctx.scope, key);
  return cli.json(['write', `${ctx.scope}::${key}`, value, ...extra]);
}

// ── setup: install, health ───────────────────────────────────────────────────

smoke('install', 'scaffolds the skills for this project without prompting', OFFLINE, async ({ cli, ctx }) => {
  cli.ok(['install', '--project', '--no-hooks', '--yes']);
  assert.ok(
    existsSync(path.join(ctx.dir, '.claude/skills/lorekit-memory/SKILL.md')),
    'install did not write .claude/skills/lorekit-memory/SKILL.md',
  );
});

smoke('install', 'wires the given endpoint into the project MCP config', REMOTE, async ({ cli, ctx }) => {
  cli.ok(['install', '--project', '--no-hooks', '--yes', '--endpoint', ctx.endpoint, '--token', ctx.token]);
  const mcp = readFileSync(path.join(ctx.dir, '.mcp.json'), 'utf8');
  assert.ok(mcp.includes(new URL(ctx.endpoint).host), `.mcp.json does not name ${ctx.endpoint}:\n${mcp}`);
});

smoke('update', 'reports freshly installed skills as up to date', OFFLINE, async ({ cli }) => {
  assert.match(cli.ok(['update', '--check']), /already (at the shipped version|up to date)/);
});

smoke('doctor', 'passes on a fresh local install', OFFLINE, async ({ cli }) => {
  const out = cli.ok(['doctor', '--mode', 'local']);
  assert.match(out, /PASS home store/);
  assert.doesNotMatch(out, /\bFAIL\b/);
});

smoke('doctor', 'completes a write → read → delete round-trip against the endpoint', REMOTE, async ({ cli }) => {
  const out = cli.ok(['doctor', '--deep']);
  assert.doesNotMatch(out, /\bFAIL\b/);
});

// ── write and read back ──────────────────────────────────────────────────────

smoke('write', 'stores a lesson from a positional value', BOTH, async ({ cli, ctx }) => {
  const out = writeLesson(cli, ctx, 'alpha', alphaValue(ctx), ['--tags', 'smoke,cli']);
  assert.equal(out.store, ctx.lane === 'remote' ? 'remote' : 'local');
  assert.equal(out.scope, ctx.scope);
  assert.equal(out.key, ctx.key('alpha'));
  assert.deepEqual(out.tags, ['smoke', 'cli']);
});

smoke('write', 'stores a lesson piped on stdin', BOTH, async ({ cli, ctx }) => {
  trackRemoteWrite(ctx, ctx.scope, ctx.key('beta'));
  const out = cli.json(['write', `${ctx.scope}::${ctx.key('beta')}`], { input: 'short body\n' });
  assert.equal(out.value, 'short body');
});

smoke('show', 'returns the full lesson that was written', BOTH, async ({ cli, ctx }) => {
  const out = cli.json(['show', `${ctx.scope}::${ctx.key('alpha')}`]);
  const block = out[storeOf(ctx)];
  assert.equal(block.found, true, `alpha not found in the ${storeOf(ctx)} store`);
  assert.equal(block.record.value, alphaValue(ctx));
});

smoke('list', 'lists the lessons that apply to this directory (also as `ls`)', BOTH, async ({ cli, ctx }) => {
  for (const cmd of ctx.lane === 'offline' ? ['list', 'ls'] : ['list']) {
    const out = cli.json([cmd]);
    const keys = keysIn(out[storeOf(ctx)]);
    assert.ok(keys.includes(ctx.key('alpha')) && keys.includes(ctx.key('beta')), `\`${cmd}\` is missing alpha/beta: ${keys}`);
  }
});

smoke('search', 'finds a lesson by a word in its body (also as `grep`)', BOTH, async ({ cli, ctx }) => {
  for (const cmd of ctx.lane === 'offline' ? ['search', 'grep'] : ['search']) {
    const out = cli.json([cmd, `zebra-${ctx.runId}`]);
    assert.deepEqual(keysIn(out[storeOf(ctx)]), [ctx.key('alpha')], `\`${cmd}\` should match alpha only`);
  }
});

smoke('stats', 'counts the lessons per scope', BOTH, async ({ cli, ctx }) => {
  const out = cli.json(['stats']);
  assert.ok(out[storeOf(ctx)].total >= 2, `expected at least 2 lessons, got ${out[storeOf(ctx)].total}`);
});

smoke('scopes', 'inventories the scopes that hold lessons', BOTH, async ({ cli, ctx }) => {
  const out = cli.json(['scopes']);
  const block = out[storeOf(ctx)];
  assert.equal(block.available, true, `the ${storeOf(ctx)} inventory is unavailable: ${block.reason}`);
  assert.ok(JSON.stringify(block.scopes).includes(ctx.scope), `${ctx.scope} missing from scopes`);
});

smoke('tree', 'shows which lesson wins for this directory (also as `resolve`)', BOTH, async ({ cli, ctx }) => {
  for (const cmd of ctx.lane === 'offline' ? ['tree', 'resolve'] : ['tree']) {
    const out = cli.json([cmd]);
    assert.ok(keysIn(out[storeOf(ctx)].winners).includes(ctx.key('alpha')), `\`${cmd}\` lists no winning alpha`);
  }
});

smoke('lint', 'fails the gate on a too-short lesson and names it', BOTH, async ({ cli, ctx }) => {
  // beta's body is deliberately short — lint is documented as a CI gate, so it must exit non-zero.
  const out = cli.json(['lint'], { code: 1 });
  const findings = JSON.stringify(out[storeOf(ctx)]);
  assert.match(
    findings,
    new RegExp(`"key":"${ctx.key('beta')}"[^}]*"rule":"short-value"`),
    `no short-value finding for beta: ${findings}`,
  );
});

smoke('dedupe', 'clusters a near-duplicate lesson', BOTH, async ({ cli, ctx }) => {
  writeLesson(cli, ctx, 'alpha-copy', alphaValue(ctx));
  const out = cli.json(['dedupe']);
  const clusters = JSON.stringify(out[storeOf(ctx)].clusters);
  assert.ok(
    clusters.includes(`"${ctx.key('alpha-copy')}"`) && clusters.includes(`"${ctx.key('alpha')}"`),
    `alpha/alpha-copy not clustered: ${clusters}`,
  );
});

smoke('delete', 'hard-deletes with --force (also as `rm`)', BOTH, async ({ cli, ctx }) => {
  const cmd = ctx.lane === 'offline' ? 'rm' : 'delete';
  const out = cli.json([cmd, `${ctx.scope}::${ctx.key('alpha-copy')}`, '--force']);
  assert.equal(out.ok, true);
  assert.equal(out.force, true);
  // `show` exits 1 for a lesson that is not there — the deletion is the point.
  assert.equal(cli.json(['show', `${ctx.scope}::${ctx.key('alpha-copy')}`], { code: 1 })[storeOf(ctx)].found, false);
});

smoke('diff', 'reports offline-vs-remote divergence only when both stores are readable', BOTH, async ({ cli, ctx }) => {
  const out = cli.json(['diff']);
  assert.equal(out.comparable, ctx.lane === 'remote', JSON.stringify(out).slice(0, 400));
});

// ── archive lifecycle ────────────────────────────────────────────────────────

smoke('archive', 'hides a lesson from the default listing', BOTH, async ({ cli, ctx }) => {
  cli.ok(['archive', `${ctx.scope}::${ctx.key('beta')}`]);
  assert.ok(!keysIn(cli.json(['list'])[storeOf(ctx)]).includes(ctx.key('beta')), 'beta still listed after archive');
});

smoke('restore', 'brings an archived lesson back', BOTH, async ({ cli, ctx }) => {
  cli.ok(['restore', `${ctx.scope}::${ctx.key('beta')}`]);
  assert.ok(keysIn(cli.json(['list'])[storeOf(ctx)]).includes(ctx.key('beta')), 'beta not listed after restore');
});

// ── tools that read the store but change nothing ─────────────────────────────

smoke('obligations', 'maps a changed file to the partners it obliges', BOTH, async ({ cli }) => {
  const out = cli.json(['obligations', 'packages/schemas/src/shared/tool-catalog.ts']);
  assert.ok(Array.isArray(out.matched) && out.matched.length > 0, 'tool-catalog.ts matched no obligation');
});

smoke('invariants', 'scans for compile-pipeline candidates', BOTH, async ({ cli, ctx }) => {
  const out = cli.json(['invariants', 'candidates']);
  assert.equal(out[storeOf(ctx)].available, true);
  assert.ok(Array.isArray(out[storeOf(ctx)].candidates));
});

smoke('link', 'builds a dashboard deep link to one lesson (also as `url`)', OFFLINE, async ({ cli, ctx }) => {
  for (const cmd of ['link', 'url']) {
    const out = cli.json([cmd, `${ctx.scope}::${ctx.key('alpha')}`]);
    assert.ok(out.url.startsWith('https://lorekit.io/lore?'), out.url);
    assert.deepEqual(out.params.lesson, { scope: ctx.scope, key: ctx.key('alpha') });
  }
});

smoke('migrate', 'previews a move between stores without writing', BOTH, async ({ cli, ctx }) => {
  const from = path.join(ctx.home, '.lorekit');
  const to = ctx.lane === 'remote' ? 'remote' : 'project';
  if (ctx.lane === 'remote') {
    // Give the dry run something to report: one lesson in the local home tier.
    cli.ok(['write', `${ctx.scope}::${ctx.key('local-only')}`, 'A lesson that only exists offline.', '--local']);
  }
  const out = cli.ok(['migrate', '--from', from, '--to', to]);
  assert.match(out, /dry-run/);
});

smoke('bootstrap', 'explains that it only applies to a bring-your-own database', OFFLINE, async ({ cli }) => {
  assert.match(cli.ok(['bootstrap', '--yes']), /No BYOD storage configured/);
});

smoke('completion', 'prints zsh and fish completion scripts', OFFLINE, async ({ cli }) => {
  assert.match(cli.ok(['completion', 'zsh']), /^#compdef lorekit/);
  assert.match(cli.ok(['completion', 'fish']), /complete -c lorekit/);
});

smoke('hook', 'injects the applicable lessons at SessionStart', BOTH, async ({ cli, ctx }) => {
  const payload = JSON.stringify({ hook_event_name: 'SessionStart', cwd: ctx.dir, session_id: `smoke-${ctx.runId}` });
  const out = cli.ok(['hook', '--adapter', 'claude', '--event', 'SessionStart'], { input: payload });
  const hook = JSON.parse(out);
  assert.equal(hook.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.ok(hook.hookSpecificOutput.additionalContext.includes(`zebra-${ctx.runId}`), 'alpha was not injected');
});

// ── the local stdio MCP server ───────────────────────────────────────────────

smoke('mcp', 'serves the catalog over stdio and answers every memory tool', OFFLINE, async ({ ctx }) => {
  const s = ctx.scope;
  const gamma = ctx.key('gamma');
  const session = runMcp(ctx, [
    { name: 'memory.write', arguments: { scope: s, key: gamma, value: 'Written over the stdio MCP server.' } },
    { name: 'memory.read', arguments: { scope: s, key: gamma } },
    { name: 'memory.list', arguments: { scope: s } },
    // The local server searches the scopes it is given (mcp-server.mjs: list and
    // search "need a scope (or a scope list) up front").
    { name: 'memory.search', arguments: { q: 'stdio MCP server', scopes: [s] } },
    { name: 'memory.scopes', arguments: {} },
    { name: 'memory.archive', arguments: { scope: s, key: gamma } },
    { name: 'memory.restore', arguments: { scope: s, key: gamma } },
    { name: 'memory.delete', arguments: { scope: s, key: gamma, force: true } },
    // org.* needs a remote; offline they must refuse and say how to fix it.
    { name: 'org.create', arguments: { slug: 'smoke-org', name: 'Smoke' } },
    { name: 'org.list', arguments: {} },
    { name: 'org.rename', arguments: { slug: 'smoke-org', name: 'Renamed' } },
    { name: 'org.delete', arguments: { slug: 'smoke-org' } },
  ]);
  assert.equal(session.code, 0, `lorekit mcp exited ${session.code}: ${session.stderr}`);
  assert.equal(session.serverInfo?.name, 'lorekit-local');
  assert.deepEqual([...session.tools].sort(), [...LOCAL_MCP_TOOLS].sort(), 'advertised tools drifted from the catalog');

  const [write, read, list, search, scopes, archive, restore, del, ...orgs] = session.results;
  for (const [name, r] of Object.entries({ write, read, list, search, scopes, archive, restore, delete: del })) {
    assert.equal(r.ok, true, `memory.${name} was refused: ${JSON.stringify(r.error)}`);
  }
  assert.ok(JSON.stringify(read.value).includes('Written over the stdio MCP server.'), 'memory.read lost the body');
  assert.ok(keysIn(list.value).includes(gamma), 'memory.list is missing gamma');
  assert.ok(keysIn(search.value).includes(gamma), 'memory.search did not find gamma');
  assert.ok(JSON.stringify(scopes.value).includes(s), 'memory.scopes is missing the run scope');
  for (const r of orgs) {
    assert.equal(r.ok, false, 'an org.* tool succeeded with no remote');
    assert.match(String(r.error), /remote LoreKit endpoint/);
  }
});

smoke('mcp', 'passes tools through to the endpoint over stdio', REMOTE, async ({ ctx }) => {
  const session = runMcp(ctx, [{ name: 'memory.read', arguments: { scope: ctx.scope, key: ctx.key('alpha') } }]);
  assert.equal(session.code, 0, `lorekit mcp exited ${session.code}: ${session.stderr}`);
  assert.ok(session.tools.includes('memory.read'), `tools/list: ${session.tools}`);
  assert.equal(session.results[0].ok, true, JSON.stringify(session.results[0].error));
  assert.ok(JSON.stringify(session.results[0].value).includes(`zebra-${ctx.runId}`), 'memory.read lost the body');
});

// ── remote-only commands ─────────────────────────────────────────────────────

// Offline, each must refuse with an actionable message rather than pretend to
// work. Against an endpoint, each must actually do its job.
const REMOTE_ONLY = [
  ['protect', (ctx) => ['protect', `${ctx.scope}::${ctx.key('alpha')}`]],
  ['pin', (ctx) => ['pin', `${ctx.scope}::${ctx.key('alpha')}`]],
  ['unpin', (ctx) => ['unpin', `${ctx.scope}::${ctx.key('alpha')}`]],
  ['policy', () => ['policy', 'list']],
  ['groom', (ctx) => ['groom', '--scope', ctx.scope]],
  ['purge', () => ['purge', '--yes']],
  ['purge-expired', () => ['purge-expired', '--yes']],
];
for (const [command, args] of REMOTE_ONLY) {
  smoke(command, 'refuses offline and names what is missing', OFFLINE, async ({ cli, ctx }) => {
    cli.fails(args(ctx), /remote store is not configured/);
  });
}

// protect / pin / unpin / policy / groom are owner-keyed: the server refuses a
// service-role credential (it has no user to own the row), as the hosted MCP
// smoke does for the same tools. Preview's smoke token is service-role.
const OWNERLESS = 'skipped: owner-keyed — a service-role credential has no owner';

smoke('protect', 'protects and unprotects a lesson', REMOTE, async ({ cli, ctx }) => {
  if (ctx.tier === 'service') return OWNERLESS;
  assert.equal(cli.json(['protect', `${ctx.scope}::${ctx.key('alpha')}`]).protected, true);
  assert.equal(cli.json(['protect', `${ctx.scope}::${ctx.key('alpha')}`, '--off']).protected, false);
});

smoke('pin', 'is shorthand for protect', REMOTE, async ({ cli, ctx }) => {
  if (ctx.tier === 'service') return OWNERLESS;
  assert.equal(cli.json(['pin', `${ctx.scope}::${ctx.key('alpha')}`]).protected, true);
});

smoke('policy', 'creates, lists, updates and deletes a retention policy', REMOTE, async ({ cli, ctx }) => {
  if (ctx.tier === 'service') return OWNERLESS;
  const created = cli.json(['policy', 'create', '--scope', ctx.scope, '--name', `cli smoke ${ctx.runId}`, '--tags', 'groom-me']);
  const id = created.policy?.id;
  assert.ok(id, `policy create returned no id: ${JSON.stringify(created)}`);
  ctx.policies.add(id);

  assert.ok(cli.json(['policy', 'list']).entries.some((p) => p.id === id), 'the new policy is not listed');
  const renamed = `cli smoke ${ctx.runId} renamed`;
  assert.equal(cli.json(['policy', 'update', id, '--name', renamed]).policy?.name, renamed);
  ctx.state.policyId = id;
});

smoke('groom', 'archives what a policy matches, but never a protected lesson', REMOTE, async ({ cli, ctx }) => {
  if (ctx.tier === 'service') return OWNERLESS;
  writeLesson(cli, ctx, 'groom-target', 'A lesson the smoke policy should archive.', ['--tags', 'groom-me']);
  writeLesson(cli, ctx, 'groom-keeper', 'A protected lesson the smoke policy must not touch.', ['--tags', 'groom-me']);
  cli.json(['protect', `${ctx.scope}::${ctx.key('groom-keeper')}`]);

  const preview = cli.json(['groom', '--policy-id', ctx.state.policyId]);
  assert.deepEqual(keysIn(preview.keys), [ctx.key('groom-target')], `preview: ${JSON.stringify(preview.keys)}`);

  const run = cli.json(['groom', '--policy-id', ctx.state.policyId, '--run', '--yes']);
  assert.equal(run.archived, 1);
  assert.equal(cli.json(['show', `${ctx.scope}::${ctx.key('groom-keeper')}`]).remote.found, true, 'groom archived a protected lesson');
});

smoke('unpin', 'is shorthand for protect --off', REMOTE, async ({ cli, ctx }) => {
  if (ctx.tier === 'service') return OWNERLESS;
  assert.equal(cli.json(['unpin', `${ctx.scope}::${ctx.key('groom-keeper')}`]).protected, false);
  // Delete the policy here rather than leave it to cleanup, so `policy delete` is exercised too.
  assert.equal(cli.json(['policy', 'delete', ctx.state.policyId, '--yes']).deleted, true);
  ctx.policies.delete(ctx.state.policyId);
});

smoke('purge-expired', 'sweeps expired lessons for this account', REMOTE, async ({ cli, ctx }) => {
  if (ctx.tier !== 'api_key') return 'skipped: account-wide sweep needs a user-scoped lk_* token';
  assert.equal(cli.json(['purge-expired', '--yes']).ok, true);
});

smoke('purge', 'purges archived lessons past the retention window', REMOTE, async ({ cli, ctx }) => {
  if (ctx.tier !== 'api_key') return 'skipped: account-wide sweep needs a user-scoped lk_* token';
  // 365 days: only archived rows older than a year — nothing this run created.
  assert.equal(cli.json(['purge', '--retention-days', '365', '--yes']).ok, true);
});

// ── teardown ─────────────────────────────────────────────────────────────────

smoke('delete', 'archives without --force', BOTH, async ({ cli, ctx }) => {
  const out = cli.json(['delete', `${ctx.scope}::${ctx.key('beta')}`]);
  assert.equal(out.ok, true);
  assert.equal(out.force, false);
});

smoke('uninstall', 'removes what install wrote', BOTH, async ({ cli, ctx }) => {
  cli.ok(['uninstall', '--project', '--yes']);
  assert.ok(!existsSync(path.join(ctx.dir, '.claude/skills/lorekit-memory')), 'the skill is still installed');
});
