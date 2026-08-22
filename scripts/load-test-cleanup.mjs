#!/usr/bin/env node
/**
 * Sweep users left behind by a load test.
 *
 * `load-test.mjs` deletes its own users in a `finally`, so this only has work to
 * do when a run was killed hard enough to skip that — a runner timeout, a
 * cancelled job, a crashed container. It exists because the residue is real rows
 * in a real project, and on production it is somebody's tenant.
 *
 * SAFETY — three independent guards, each load-bearing:
 *
 *   1. The email must match the ANCHORED pattern below. Not a prefix test, not a
 *      `LIKE 'loadtest%'`: a fully anchored shape including the run id and the
 *      reserved `@lorekit.test` domain. A permissive pattern here is a script
 *      that deletes real accounts.
 *   2. The user must be OLDER than `--older-than` minutes (default 60). A load
 *      test provisions users seconds before it uses them, so without an age
 *      floor a sweep running concurrently with a real run would delete its users
 *      mid-flight and the run would report a wall of 401s.
 *   3. Service-role credentials are required, and nothing is deleted unless the
 *      Auth admin API actually lists the user. It never deletes by constructed
 *      id.
 *
 * Deleting a user cascades to their memories and their `user_limits` row, so one
 * delete per user is the whole cleanup.
 *
 * USAGE
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/load-test-cleanup.mjs
 *   … --older-than 5      # minutes
 *   … --dry-run           # list what WOULD be deleted
 */

import { checkServiceCredential } from './load-test-lib.mjs';

/**
 * The one pattern that decides what is ours to touch.
 *
 * Mirrors the email `load-test.mjs` mints: `loadtest-<8 hex>-<index>@lorekit.test`.
 * Exported so a test can assert it rejects a real-looking address; anchored at
 * both ends so nothing longer can slip through.
 */
export const LOAD_USER_EMAIL = /^loadtest-[0-9a-f]{8}-\d+@lorekit\.test$/;

/** Whether an email is a load-test artefact. Total: any non-string is false. */
export function isLoadTestEmail(email) {
  return typeof email === 'string' && LOAD_USER_EMAIL.test(email);
}

/**
 * Whether a user is old enough to sweep.
 *
 * An unparseable or missing `created_at` returns FALSE — fail closed. A user we
 * cannot date is a user we cannot prove is stale, and the cost of skipping one
 * is a warning while the cost of deleting a live one is a broken run.
 */
export function isStale(createdAt, olderThanMinutes, now = Date.now()) {
  const t = Date.parse(createdAt ?? '');
  if (!Number.isFinite(t)) return false;
  return now - t >= olderThanMinutes * 60_000;
}

/** Select the users this sweep may delete. Pure, so the guards are testable. */
export function selectSweepable(users, olderThanMinutes, now = Date.now()) {
  return (users ?? []).filter(
    (u) => isLoadTestEmail(u?.email) && isStale(u?.created_at, olderThanMinutes, now),
  );
}

// ── runner ───────────────────────────────────────────────────────────────────

// Importable for tests without running the sweep: `node --test` imports this
// file for the pure guards above, and must not start deleting anything.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());

if (isMain) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const idx = argv.indexOf('--older-than');
  const olderThan = idx >= 0 ? Number(argv[idx + 1]) : 60;

  if (!Number.isFinite(olderThan) || olderThan < 0) {
    console.error('✗ --older-than must be a non-negative number of minutes.');
    process.exit(1);
  }

  const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceKey) {
    console.error('✗ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    process.exit(1);
  }

  const admin = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  // Page through the admin list rather than guessing ids.
  const all = [];
  for (let page = 1; page <= 20; page += 1) {
    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: admin });
    if (!res.ok) {
      console.error(`✗ listing users failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      // A 401 here reads as a bad key but is usually a MISMATCHED one, so say
      // which before exiting — the sweeper runs `if: always()`, so this is
      // often the only place the operator sees the credential explained.
      for (const e of checkServiceCredential({ serviceKey, anonKey: '', supabaseUrl }).errors) {
        console.error(`  → ${e}`);
      }
      process.exit(1);
    }
    const body = await res.json();
    const users = body?.users ?? [];
    all.push(...users);
    if (users.length < 200) break;
  }

  const targets = selectSweepable(all, olderThan);
  console.log(`Scanned ${all.length} users; ${targets.length} match the load-test pattern and are ≥ ${olderThan} min old.`);

  if (!targets.length) process.exit(0);

  if (dryRun) {
    for (const u of targets) console.log(`  would delete ${u.email} (created ${u.created_at})`);
    process.exit(0);
  }

  let removed = 0;
  for (const u of targets) {
    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: admin });
    if (res.ok) { removed += 1; console.log(`  deleted ${u.email}`); }
    else console.error(`  ⚠ ${u.email}: ${res.status}`);
  }
  console.log(`Removed ${removed}/${targets.length}.`);
  if (removed < targets.length) process.exitCode = 1;
}
