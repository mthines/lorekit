#!/usr/bin/env node
/**
 * Seed the shared preview Supabase project with a realistic, backdated
 * dataset — memories across every filterable dimension, an org, and 30 days
 * of usage/read/citation activity — so the dashboard shows a lived-in
 * workspace instead of an empty account after a fresh `/preview` deploy.
 *
 * PREVIEW ONLY. This script refuses the production project ref unconditionally
 * — there is no override flag, matching rebuild-preview.yml's own
 * belt-and-suspenders check. Seeding writes backdated demo rows under a real
 * account; that is a reasonable thing to do to a disposable preview project
 * and never to production.
 *
 * ## Execution channel
 *
 * Two ways to reach the database, so this also works against a local
 * `supabase start` stack without a Management API token:
 *
 *   --target preview   Supabase Management API (`POST /v1/projects/{ref}/database/query`),
 *                       authenticated with SUPABASE_ACCESS_TOKEN — the same
 *                       repo-level secret every deploy workflow already holds.
 *                       No new secret. Reads SUPABASE_PROJECT_REF.
 *   --psql <url>        Direct `psql` against a local/self-hosted Postgres —
 *                       for `supabase start` or a BYOD project. Never used in
 *                       CI (the runner has no route to a pooler host).
 *
 * ## Usage
 *
 *   SUPABASE_ACCESS_TOKEN=… SUPABASE_PROJECT_REF=<preview-ref> \
 *     node scripts/seed/seed-preview.mjs --target preview --user-email you@example.com
 *
 *   node scripts/seed/seed-preview.mjs --psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     --user-email you@example.com
 *
 *   node scripts/seed/seed-preview.mjs --target preview --user-email … --dry-run   # print SQL, write nothing
 *   node scripts/seed/seed-preview.mjs --target preview --user-email … --reset     # wipe this seed's rows first
 *
 * The target user must already exist (seed it with
 * scripts/smoke/seed-smoke-user.mjs first) — this script never creates one,
 * for the same reason the smoke suites don't: provisioning a user is a
 * separate, deliberate, out-of-CI act.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildDataset, SEED_KEY_PREFIX } from './preview-dataset.mjs';
import {
  renderOrgSql,
  renderMemoriesSql,
  renderReadDailySql,
  renderCitationsSql,
  renderUsageEventsSql,
  renderResetSql,
  sqlString,
} from './preview-sql.mjs';

/** The one project this script will never touch, no matter what flag is passed. */
export const PRODUCTION_PROJECT_REF = 'pqokxlhvnosogizsjztg';

// ── argv ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = {
    target: null, psqlUrl: null, projectRef: null, userEmail: null,
    days: 30, reset: false, dryRun: false,
  };
  const flags = {
    '--target': 'target', '--psql': 'psqlUrl', '--project-ref': 'projectRef',
    '--user-email': 'userEmail', '--days': 'days',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--reset') { opts.reset = true; continue; }
    if (argv[i] === '--dry-run') { opts.dryRun = true; continue; }
    const key = flags[argv[i]];
    if (key) { opts[key] = argv[i + 1]; i += 1; }
  }
  opts.days = Number.parseInt(opts.days, 10);
  return opts;
}

/**
 * Resolve which channel reaches the database, and refuse production before
 * anything else runs. Pure decision logic — no I/O — so it is unit-testable
 * without a network.
 */
export function resolveChannel(opts, env = {}) {
  if (opts.psqlUrl) {
    return { ok: true, channel: 'psql', url: opts.psqlUrl };
  }
  const ref = opts.projectRef ?? env.SUPABASE_PROJECT_REF ?? '';
  if (!ref) {
    return { ok: false, error: 'No target. Pass --psql <url> for a local stack, or set SUPABASE_PROJECT_REF (with SUPABASE_ACCESS_TOKEN) for the preview project.' };
  }
  if (ref === PRODUCTION_PROJECT_REF) {
    return { ok: false, error: `Refusing to seed the PRODUCTION project (${PRODUCTION_PROJECT_REF}). This script only ever targets a preview or local stack — there is no override.` };
  }
  const accessToken = env.SUPABASE_ACCESS_TOKEN ?? '';
  // A dry-run never calls the network, so it can preview the SQL for a real
  // project ref without a real token on hand.
  if (!accessToken && !opts.dryRun) {
    return { ok: false, error: 'SUPABASE_PROJECT_REF is set but SUPABASE_ACCESS_TOKEN is missing — both are required for the Management API channel.' };
  }
  return { ok: true, channel: 'api', ref, accessToken };
}

// ── execution ────────────────────────────────────────────────────────────────

/**
 * One SQL round trip via the Supabase Management API. Node's built-in fetch
 * ignores HTTPS_PROXY (see CLAUDE.md's sandbox-baseline note #6) — set
 * NODE_USE_ENV_PROXY=1 in whatever shell runs this if it 403s with "host not
 * in allowlist" for a host that IS allowlisted.
 */
async function execApi({ ref, accessToken, sql }) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Management API query failed (${res.status}): ${text.slice(0, 2000)}`);
  }
  return text ? JSON.parse(text) : [];
}

/** One SQL round trip via `psql -f <tmpfile>`, so quoting never touches a shell. */
function execPsql({ url, sql }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lorekit-seed-'));
  const file = path.join(dir, 'seed.sql');
  try {
    // -t -A: unaligned, no header — the one caller that reads rows back
    // (resolveUserId) parses this format itself.
    writeFileSync(file, sql, 'utf8');
    const res = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-f', file], { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`psql failed (exit ${res.status}): ${res.stderr || res.stdout}`);
    }
    return res.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runSql(channelInfo, sql) {
  if (channelInfo.channel === 'api') {
    return execApi({ ref: channelInfo.ref, accessToken: channelInfo.accessToken, sql });
  }
  return execPsql({ url: channelInfo.url, sql });
}

/** Look up the seed target's user id by email. Never creates one. */
async function resolveUserId(channelInfo, email) {
  const sql = `select id from auth.users where email = ${sqlString(email)} limit 1;`;
  const result = await runSql(channelInfo, sql);
  const id = channelInfo.channel === 'api'
    ? result?.[0]?.id
    : String(result).trim().split('\n')[0]?.trim();
  if (!id) {
    throw new Error(
      `No user found for email ${email}. Seed it first with:\n` +
      `  SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… LOREKIT_SMOKE_EMAIL=${email} LOREKIT_SMOKE_PASSWORD=… node scripts/smoke/seed-smoke-user.mjs`,
    );
  }
  return id;
}

// ── orchestration ────────────────────────────────────────────────────────────

/** Build every SQL statement this run needs, in EXECUTION ORDER (FK-dependency order). */
export function buildStatements({ dataset, userId, reset }) {
  const statements = [];
  if (reset) statements.push({ name: 'reset', sql: renderResetSql(dataset.org, userId) });
  statements.push({ name: 'org', sql: renderOrgSql(dataset.org, userId) });
  statements.push({ name: 'memories', sql: renderMemoriesSql(dataset.memories, userId) });
  const memoryIds = dataset.memories.map((m) => m.id);
  statements.push({ name: 'read_daily', sql: renderReadDailySql(dataset.readDaily, memoryIds) });
  statements.push({ name: 'citations', sql: renderCitationsSql(dataset.citations, memoryIds) });
  statements.push({ name: 'usage_events', sql: renderUsageEventsSql(dataset.usageEvents, userId) });
  return statements;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.userEmail) {
    console.error('Missing --user-email <email>. The account whose lore/usage this seeds — must already exist (see scripts/smoke/seed-smoke-user.mjs).');
    process.exit(1);
  }
  const resolved = resolveChannel(opts, process.env);
  if (!resolved.ok) {
    console.error(`::error::${resolved.error}`);
    process.exit(1);
  }

  const dataset = buildDataset({ now: new Date(), days: Number.isFinite(opts.days) ? opts.days : 30 });
  console.log(`Dataset: ${dataset.memories.length} memories, ${dataset.usageEvents.length} usage events, ${dataset.readDaily.length} read-daily rows, ${dataset.citations.length} citations, keys prefixed "${SEED_KEY_PREFIX}".`);

  if (opts.dryRun) {
    console.log(`\n[dry-run] Resolving on channel: ${resolved.channel === 'api' ? `Management API (ref ${resolved.ref})` : `psql (${resolved.url})`}`);
    console.log('[dry-run] Would resolve user id for', opts.userEmail, 'then run:');
    const statements = buildStatements({ dataset, userId: '<resolved-user-id>', reset: opts.reset });
    for (const s of statements) {
      console.log(`\n-- ${s.name} --\n${s.sql}`);
    }
    return;
  }

  const userId = await resolveUserId(resolved, opts.userEmail);
  console.log(`Seeding as user ${opts.userEmail} (${userId})${opts.reset ? ' — resetting first' : ''}...`);

  const statements = buildStatements({ dataset, userId, reset: opts.reset });
  for (const s of statements) {
    console.log(`Running ${s.name}...`);
    await runSql(resolved, s.sql);
  }

  console.log(`Done. Sign in to the preview dashboard as ${opts.userEmail} to see it — filter the Explorer by "${SEED_KEY_PREFIX}" to find exactly these rows.`);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('seed-preview.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
