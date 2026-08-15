// `lorekit migrate --from <path> [--to home|project|remote] [--yes|--apply]`
//
// Relocation / rename tool — NOT a persistent-memory importer. It reads a
// LoreKit-format local store at <path> (e.g. an old `.lore/` directory, or a
// store that was moved elsewhere) and re-writes its entries into the resolved
// current-layout store(s), so lessons are never stranded by a rename or a move.
//
// `--to remote` is the one destination that leaves the machine: it pushes the
// source store up to the hosted store, which is the local→remote transition a
// user who started offline and then connected a token had no bulk path for.
// Everything else about the command is unchanged by it — same dry-run default,
// same per-scope report, same idempotency — because the destination is just
// another store behind the same `getEntry`/`putEntry` pair.
//
// Dry-run (preview) by default: it prints what would move, per scope, and
// changes nothing. Only `--yes` (or `--apply`) mutates. Idempotent: entries are
// upserted verbatim by scope+key, so a re-run is all NOOP.
//
// Out of scope: reading persistent-memory's `~/.agent-memory/<bucket>/INDEX.md`
// + `entries/` format. This tool only understands LoreKit's own on-disk format.
// Also out of scope: the reverse direction (remote → local) and `--org <slug>`
// org-owned writes; a v1 migration always lands as the caller's personal lore.
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot, tokenKind } from './config.mjs';
import { localStoreDirs, loadControl } from './control.mjs';
import { createLocalStore, createTwoTierStore, createRemoteStore } from './store/index.mjs';
import { parseEntry } from './store/format.mjs';
import { isLive, TTL_MAX_DAYS } from './store/ttl.mjs';
import { remoteWriteLosses } from './store/remote.mjs';
import {
  createPacer, withRetry, isMemoryCap, sleep, DEFAULT_CONSECUTIVE_FAILURE_LIMIT,
} from './store/rate-limit.mjs';
import { log, heading, status, err, c } from './util.mjs';

// Recursively collect every parseable LoreKit entry under a base dir. The
// canonical scope comes from each file's frontmatter, so the source layout does
// not have to match the destination layout.
function collectEntries(base) {
  const out = [];
  const walk = (dir) => {
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith('.md')) {
        try {
          const entry = parseEntry(fs.readFileSync(p, 'utf8'));
          if (entry && entry.scope && entry.key) out.push(entry);
        } catch {
          // Skip an unreadable / non-entry file rather than abort the migration.
        }
      }
    }
  };
  walk(base);
  return out;
}

// Full-field equality (ignoring nothing) so a re-run after apply is NOOP.
function sameEntry(a, b) {
  if (!a || !b) return false;
  const norm = (e) =>
    JSON.stringify({
      tags: [...(e.tags || [])].sort(),
      source_agent: e.source_agent ?? null,
      trigger: e.trigger ?? null,
      created: e.created ?? null,
      updated: e.updated ?? null,
      archived_at: e.archived_at ?? null,
      value: e.value == null ? '' : String(e.value),
    });
  return norm(a) === norm(b);
}

// The remote counterpart of `sameEntry`, and deliberately a DIFFERENT one —
// not weaker, but mirrored against what the hosted write actually stores.
//
// It compares only the fields a hosted write can actually change. Everything
// else the row carries is server-owned, and including any of it would make the
// command permanently non-idempotent rather than more accurate:
//
//   `created_at`  is honoured on INSERT only, so a row that already exists with
//                 a different creation date can never be made to match — every
//                 re-run would report UPDATE and re-push the whole store.
//   `updated_at`  is stamped at the write instant, so it differs by definition
//                 the moment the comparison runs.
//   `expires_at`  is recomputed from `ttl_days` at write time, so the two
//                 instants drift apart the moment they agree. What is
//                 comparable is whether the hosted expiry SATISFIES the local
//                 one — see `sameRemoteTtl`.
//
// A remote NOOP therefore means "the hosted lesson already says this", not
// "the two rows are byte-identical". That is the honest guarantee, and it is
// the one that makes a second `--yes` a no-op.
function sameRemoteEntry(current, entry, now = new Date()) {
  if (!current || !entry) return false;
  // The hosted write TRIMS `value` (`MemoryWriteSchema`), so comparing the
  // untrimmed local text against the trimmed hosted one would report UPDATE
  // for a padded entry on every single run and re-push it forever.
  const value = (e) => (e.value == null ? '' : String(e.value)).trim();
  const scalar = (e) =>
    JSON.stringify({
      tags: [...(e.tags || [])].sort(),
      source_agent: e.source_agent ?? null,
      trigger: e.trigger ?? null,
      value: value(e),
    });
  if (scalar(current) !== scalar(entry)) return false;

  // Provenance is COALESCED server-side, so a local entry that knows nothing
  // about a field can never make the hosted row forget it. Comparing the two
  // directly would report UPDATE forever; the honest question is whether the
  // fields this entry DOES carry already match.
  for (const f of ['origin_repo', 'origin_branch', 'origin_commit', 'origin_pr']) {
    if (entry[f] == null) continue;
    if (String(current[f] ?? '') !== String(entry[f])) return false;
  }

  return sameRemoteTtl(current.expires_at, entry.expires_at, now);
}

// Whether the hosted row's expiry still honours the local entry's intent.
//
// The instants cannot be compared. A push recomputes `expires_at` from
// `ttl_days` at the write instant and it then stays fixed, while the local
// intent is always measured from NOW — so the two drift apart the moment they
// agree, and any test for equality (or for "hosted >= what I would write
// today") re-pushes the entry on every run forever. An over-365-day entry is
// the worst case: its hosted row is capped at the API maximum and can never
// catch up with the local date at all.
//
// So the question is not "do these match" but "has the hosted lesson lost
// enough of its intended life to be worth rewriting":
//
//   both permanent          → honoured.
//   one permanent, one not  → different intent, re-push.
//   both expiring           → honoured while the hosted row still has at least
//                             HALF the life the local entry asks for (the ask
//                             itself capped at the API maximum, since that is
//                             the longest a write can request). A fresh push
//                             leaves the two equal and the entry then coasts
//                             for half its TTL before one re-push refreshes
//                             it — bounded and convergent, never a loop.
//
// The threshold is what makes it converge, and it is deliberately generous in
// both directions: a hosted row expiring in 7 days does NOT honour a 300-day
// lesson, and one expiring within the hour does NOT honour a one-day lesson,
// so a genuinely shortened TTL still migrates.
const TTL_HONOURED_FRACTION = 0.5;

function sameRemoteTtl(currentExpiry, entryExpiry, now = new Date()) {
  if (!currentExpiry && !entryExpiry) return true;
  if (!currentExpiry || !entryExpiry) return false;
  const hosted = Date.parse(currentExpiry);
  const local = Date.parse(entryExpiry);
  // An unparseable value on either side is not a difference we can act on —
  // `putEntry` leaves the hosted expiry alone in that case, so re-pushing
  // would change nothing.
  if (Number.isNaN(hosted) || Number.isNaN(local)) return true;
  const at = now.getTime();
  // What a write could actually ask for, from now: the local intent, capped at
  // the API's maximum.
  const asked = Math.min(local - at, TTL_MAX_DAYS * 86_400_000);
  if (asked <= 0) return true; // the local entry is expiring anyway
  return hosted - at >= asked * TTL_HONOURED_FRACTION;
}

// The global connection flags, folded into the environment the resolver reads.
// A COPY of the shim `doctor.mjs` and `mcp-server.mjs` use (kept local for the
// same reason theirs are: `resolveControl` is a pure resolver that takes an
// env object, and threading flags through it is each command's own business).
function withOverrides(args) {
  const env = { ...process.env };
  if (args.endpoint) env.LOREKIT_MCP_URL = args.endpoint;
  if (args.token) env.LOREKIT_TOKEN = args.token;
  if (args.store) env.LOREKIT_STORE = args.store;
  return env;
}

// Name the entries a remote write altered, then tally them. A bare count tells
// a user something was changed without telling them what — and these are
// silent changes, so they are the ones most worth naming.
function reportAltered(keys, apply, what) {
  if (!keys.length) return;
  for (const key of keys.slice(0, ALTERED_LIST_CAP)) status('warn', key, what);
  if (keys.length > ALTERED_LIST_CAP) {
    log(`  ${c.dim(`… and ${keys.length - ALTERED_LIST_CAP} more`)}`);
  }
  log(`  ${keys.length} entr${keys.length === 1 ? 'y' : 'ies'}: ${apply ? '' : 'would have '}${what}.`);
}

// How many altered entries to name before summarising the rest. A migration
// can carry thousands; naming every one would bury the summary it belongs to.
const ALTERED_LIST_CAP = 10;

// Resolve the hosted store to push to, or the reason we cannot.
//
// Every check here is a PREFLIGHT: it runs once, before the first entry, so a
// misconfigured run fails in one line instead of halfway through a push with
// an unknown amount already written.
//
// Returns `{ error }` when the destination is unusable, else
// `{ store, endpoint, warnings, classify }` — where `classify` is false when
// the token cannot READ, so the caller must not try to.
export function resolveRemoteDestination(control, args = {}) {
  const denied = (control.denies || []).find((d) => d.mode === 'remote');
  if (denied) {
    return { error: `remote mode is denied by ${denied.source} — a migration cannot override a deny` };
  }

  // The global `-e/--endpoint` and `-t/--token` outrank the resolved
  // connection. `withOverrides` alone is not enough for these two:
  // `resolveProjectConnection` reads `process.env` directly rather than the
  // injected env, so a flag that never touches `process.env` would be silently
  // ignored — which is exactly what happened before.
  const resolved = control.connection || {};
  const endpoint = (typeof args.endpoint === 'string' && args.endpoint.trim()) || resolved.endpoint || null;
  const token = (typeof args.token === 'string' && args.token.trim()) || resolved.token || null;
  const conn = {
    endpoint,
    token,
    usable: Boolean(endpoint && token && !String(endpoint).includes('<project-ref>')),
  };
  if (!conn.usable) {
    return {
      error: 'no usable remote connection is configured.\n'
        + `  Run ${c.cyan('lorekit install --endpoint <url> --token lk_rw_...')}, or set `
        + 'LOREKIT_MCP_URL + LOREKIT_TOKEN.',
    };
  }

  // The token's PREFIX is a local, offline claim about its permissions, which
  // is exactly what a preflight needs: a read-only token is rejected before a
  // single request rather than 403-ing on the first write, mid-run.
  const kind = tokenKind(conn.token);
  if (kind === 'read-only') {
    return {
      error: 'the configured token is read-only (lk_ro_*) — a migration to remote writes.\n'
        + `  Create a read+write token (${c.cyan('lk_rw_*')}) in the dashboard and re-run.`,
    };
  }

  const warnings = [];
  // Whether the destination can be READ to classify ADD / UPDATE / NOOP. A
  // write-only token's reads are denied outright, so asking would 403 every
  // entry — see `classify: false` below.
  let classify = true;
  if (kind === 'write-only') {
    // A write-only token is legitimate here — the writes will succeed — but the
    // classifying READ will 403, so every entry looks new. Say so up front
    // rather than presenting a plan that silently overstates the work.
    classify = false;
    warnings.push(
      'token is write-only (lk_wo_*) — reads are denied, so the destination is not read at all: '
      + 'every entry is reported as "add" and pushed. The writes are still idempotent server-side.',
    );
  } else if (kind === 'unknown') {
    warnings.push(
      'token has an unrecognized prefix (expected lk_rw_* / lk_ro_* / lk_wo_*) — proceeding anyway; '
      + 'a token without write permission will fail on the first write.',
    );
  }

  return {
    store: createRemoteStore({ endpoint: conn.endpoint, token: conn.token }),
    endpoint: conn.endpoint,
    warnings,
    classify,
  };
}

// `options` is a test seam, not a user-facing surface: `sleepFn` lets the
// rate-limit tests exercise the backoff without actually waiting out a window.
export async function migrate(args, options = {}) {
  const root = resolveProjectRoot(args.dir);

  const from = typeof args.from === 'string' ? args.from : null;
  if (!from) {
    err(`${c.red('migrate:')} --from <path> is required (the store to migrate from)`);
    return 1;
  }
  const src = path.isAbsolute(from) ? from : path.join(root, from);
  if (!fs.existsSync(src)) {
    err(`${c.red('migrate:')} source not found: ${src}`);
    return 1;
  }

  const to = typeof args.to === 'string' ? args.to.toLowerCase() : null;
  if (to && to !== 'home' && to !== 'project' && to !== 'remote') {
    err(`${c.red('migrate:')} --to must be "home", "project" or "remote"`);
    return 1;
  }
  const apply = Boolean(args.apply || args.yes);

  const dirs = localStoreDirs(root);

  // Resolve where each entry goes. `--to` forces a single tier; the default
  // routes each entry by scope through the two-tier store (global → home,
  // repo/branch → project when opted-in, else home).
  let targetFor;
  let destLabel;
  const remote = to === 'remote';
  let remoteWarnings = [];
  let classifyRemote = true;
  if (remote) {
    // `withOverrides` so the global `-t/--token` and `-e/--endpoint` reach the
    // resolver, exactly as `doctor` and the stdio MCP server do. Without it a
    // user who passed both on the command line still failed the preflight.
    const control = loadControl(root, { env: withOverrides(args) });
    const dest = resolveRemoteDestination(control, args);
    if (dest.error) {
      err(`${c.red('migrate:')} ${dest.error}`);
      return 1;
    }
    remoteWarnings = dest.warnings;
    classifyRemote = dest.classify !== false;
    targetFor = () => dest.store;
    destLabel = `remote (${dest.endpoint})`;
  } else if (to === 'home') {
    const store = createLocalStore(dirs.home);
    targetFor = () => store;
    destLabel = `home (${dirs.home})`;
  } else if (to === 'project') {
    if (apply) fs.mkdirSync(dirs.project, { recursive: true }); // opt-in on apply
    const store = createLocalStore(dirs.project);
    targetFor = () => store;
    destLabel = `project (${dirs.project})`;
  } else {
    const two = createTwoTierStore(dirs);
    targetFor = (scope) => two.tierFor(scope);
    destLabel = 'resolved layout (global→home, repo/branch→project-if-opted-in)';
  }

  // ONE clock for the run: the TTL comparison, the lossiness preview and the
  // conversion inside `putEntry` must not disagree about what "now" is.
  const now = options.now instanceof Date ? options.now : new Date();

  const collected = collectEntries(src);
  // A remote destination cannot represent an archived or an expired entry
  // (see `RemoteStore.putEntry`), so they are filtered here and counted rather
  // than pushed and silently revived. A local destination keeps taking them —
  // `LocalStore.putEntry` writes them verbatim, hidden state included, which is
  // the whole point of a relocation.
  const entries = remote ? collected.filter((e) => isLive(e)) : collected;
  const skipped = collected.length - entries.length;

  heading('LoreKit migrate');
  log(`  from: ${c.dim(src)}`);
  log(`  to:   ${c.dim(destLabel)}`);
  log(`  mode: ${apply ? c.bold('apply') : 'dry-run — pass --yes to apply'}`);
  log(`  found: ${collected.length} entr${collected.length === 1 ? 'y' : 'ies'}\n`);
  for (const w of remoteWarnings) status('warn', 'token', w);
  if (skipped > 0) {
    status('warn', 'skipped', `${skipped} archived or expired entr${skipped === 1 ? 'y' : 'ies'} — not representable remotely`);
  }

  // Stay under the hosted 120 req/min ceiling proactively, and survive a 429
  // reactively. Both are no-ops for a local destination, which issues no
  // requests at all — `pace()` never fills its window and `withRetry` never
  // sees a rate-limited result.
  let pacedOnce = false;
  const pace = remote
    ? createPacer({
      // The pacer's wait is deliberately NOT `options.sleepFn`. That seam
      // exists so a retry test does not wait out a backoff, and a sleep that
      // returns without the clock advancing would spin this window forever.
      // Pacing is bounded by real time, always.
      sleepFn: async (ms) => {
        // Say it once. A few-thousand-entry store otherwise sits silent for
        // minutes after the header and looks hung.
        if (!pacedOnce) {
          pacedOnce = true;
          status('info', 'pacing', 'staying under the hosted rate limit — this run will take longer');
        }
        return sleep(ms);
      },
      ...(options.maxPerWindow ? { maxPerWindow: options.maxPerWindow } : {}),
      ...(options.windowMs ? { windowMs: options.windowMs } : {}),
    })
    : async () => {};
  const call = async (fn) => {
    if (!remote) return fn();
    // `pace()` is INSIDE the retried function, so every attempt is counted
    // against the window. Pacing only the first one would leave the ceiling
    // unenforced during exactly the 429 episodes it exists to prevent.
    return withRetry(async () => { await pace(); return fn(); }, {
      sleepFn: options.sleepFn,
      onRetry: ({ attempt, delayMs }) =>
        status('warn', 'rate limit', `retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt})`),
    });
  };

  const totals = { add: 0, update: 0, noop: 0 };
  const byScope = new Map();
  let capped = null;
  let failed = 0;
  // Named, not merely counted — the same courtesy the failure list gets, so a
  // user knows WHICH lessons were altered rather than how many.
  const clamped = [];
  const redated = [];
  // A blip is worth retrying; an outage is not. Once this many entries fail
  // back to back the destination is not having a bad moment, it is down — and
  // continuing means every remaining entry pays the full retry budget before
  // failing anyway. Reset by any entry that succeeds.
  const failureLimit = options.consecutiveFailureLimit ?? DEFAULT_CONSECUTIVE_FAILURE_LIMIT;
  let consecutiveFailures = 0;
  let abandoned = false;
  for (const entry of entries) {
    const store = targetFor(entry.scope);
    // Awaited so the loop is destination-agnostic: LocalStore.getEntry is
    // synchronous and awaiting its plain return value is a no-op, while a
    // remote destination's is a REST round-trip. One code path, both stores.
    //
    // A remote read that FAILS throws rather than answering null (see
    // `RemoteStore.getEntry`), precisely so it cannot be mistaken for "not
    // there" and overwrite a hosted lesson. Report that entry and move on: one
    // unreadable key must not abort a migration, and it must not be counted as
    // migrated either. The local store never throws here.
    let current;
    try {
      // A write-only token's reads are denied, so asking would 403 every entry
      // and fail a run the preflight just promised would work. Skip straight
      // to the write; the hosted upsert is idempotent either way.
      current = classifyRemote
        ? await call(() => store.getEntry({ scope: entry.scope, key: entry.key }))
        : null;
    } catch (e) {
      failed++;
      status('fail', entry.scope, `${entry.key}: ${e?.message || 'read failed'}`);
      if (++consecutiveFailures >= failureLimit) { abandoned = true; break; }
      continue;
    }
    let verdict;
    if (!current) verdict = 'add';
    else if (remote ? sameRemoteEntry(current, entry, now) : sameEntry(current, entry)) verdict = 'noop';
    else verdict = 'update';

    // What this entry WOULD lose, computed from the entry itself so a DRY RUN
    // warns about exactly what an apply would do — reporting it only on the
    // write made the preview quietly less informative than the thing it
    // previews. Recorded only once the outcome is known, though: a write that
    // failed shortened nothing.
    const losses = remote && verdict !== 'noop'
      ? remoteWriteLosses(entry, now)
      : { ttlClamped: false, createdAtDropped: false };
    const recordLosses = () => {
      if (losses.ttlClamped) clamped.push(`${entry.scope}::${entry.key}`);
      if (losses.createdAtDropped) redated.push(`${entry.scope}::${entry.key}`);
    };
    if (!apply) recordLosses();

    if (apply && verdict !== 'noop') {
      const res = await call(() => store.putEntry(entry, { now }));
      if (res && res.ok === false) {
        // The memory cap is terminal for the whole run, not just this entry:
        // every remaining write would hit the same ceiling. Stop, and report
        // what did land — a partial migration the user can resume after
        // archiving or upgrading is far more useful than a stack trace.
        if (isMemoryCap(res)) {
          capped = res.error?.message || 'memory cap reached';
          break;
        }
        failed++;
        status('fail', entry.scope, `${entry.key}: ${res.error?.message || res.networkError || 'write failed'}`);
        if (++consecutiveFailures >= failureLimit) { abandoned = true; break; }
        continue; // not counted as migrated — the report must not claim it
      }
      recordLosses(); // the write landed, so the loss actually happened
    }
    consecutiveFailures = 0;

    totals[verdict]++;
    const s = byScope.get(entry.scope) || { add: 0, update: 0, noop: 0 };
    s[verdict]++;
    byScope.set(entry.scope, s);
  }

  for (const [scope, s] of byScope) {
    status('info', scope, `${s.add} add, ${s.update} update, ${s.noop} unchanged`);
  }

  const moved = totals.add + totals.update;
  heading('Summary');
  log(
    `  ${apply ? 'migrated' : 'would migrate'} ${moved} entr${moved === 1 ? 'y' : 'ies'} ` +
      `(${totals.add} new, ${totals.update} updated), ${totals.noop} unchanged.`,
  );
  if (skipped > 0) log(`  ${skipped} skipped (archived or expired).`);
  reportAltered(clamped, apply, 'TTL shortened to the hosted maximum of 365 days');
  reportAltered(redated, apply, 'unusable created date dropped — the server stamps the write instant');

  // A cap can fire after an entry has already failed, so the failure count is
  // reported on BOTH exits — it used to be lost whenever the cap won the race.
  const reportFailures = () => {
    if (failed > 0) {
      // "failed", not "failed to write" — an entry lands here from an
      // unreadable classification as well as from a rejected write.
      err(`${c.red('migrate:')} ${failed} entr${failed === 1 ? 'y' : 'ies'} failed (listed above).`);
    }
  };
  if (abandoned) {
    err(`\n${c.red('migrate:')} stopped after ${failureLimit} consecutive failures — the destination looks unavailable.`);
    log(`  ${moved} entr${moved === 1 ? 'y' : 'ies'} migrated before it gave up.`);
    log(`  ${c.dim('Re-run when it is healthy — the migration resumes where it stopped.')}`);
    reportFailures();
    return 1;
  }
  if (capped) {
    err(`\n${c.red('migrate:')} ${capped}`);
    log(`  ${moved} entr${moved === 1 ? 'y' : 'ies'} migrated before the cap was reached.`);
    log(`  ${c.dim('Archive unused memories or raise the plan limit, then re-run — the migration resumes where it stopped.')}`);
    reportFailures();
    return 1;
  }
  if (failed > 0) {
    err('');
    reportFailures();
    return 1;
  }
  if (!apply && moved > 0) log(`  ${c.dim('Re-run with --yes to apply.')}`);
  return 0;
}
