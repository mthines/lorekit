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
import { isLive } from './store/ttl.mjs';
import { createPacer, withRetry, isMemoryCap } from './store/rate-limit.mjs';
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

// The remote counterpart of `sameEntry`, and deliberately a WEAKER comparison.
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
//   `expires_at`  is recomputed from `ttl_days` at write time, so only the
//                 PRESENCE of an expiry is comparable, not its instant.
//
// A remote NOOP therefore means "the hosted lesson already says this", not
// "the two rows are byte-identical". That is the honest guarantee, and it is
// the one that makes a second `--yes` a no-op.
function sameRemoteEntry(current, entry) {
  if (!current || !entry) return false;
  const norm = (e, expires) =>
    JSON.stringify({
      tags: [...(e.tags || [])].sort(),
      source_agent: e.source_agent ?? null,
      trigger: e.trigger ?? null,
      origin_repo: e.origin_repo ?? null,
      origin_branch: e.origin_branch ?? null,
      origin_commit: e.origin_commit ?? null,
      origin_pr: e.origin_pr ?? null,
      expires: Boolean(expires),
      value: e.value == null ? '' : String(e.value),
    });
  return norm(current, current.expires_at) === norm(entry, entry.expires_at);
}

// Resolve the hosted store to push to, or the reason we cannot.
//
// Every check here is a PREFLIGHT: it runs once, before the first entry, so a
// misconfigured run fails in one line instead of halfway through a push with
// an unknown amount already written. Returns `{ store, warnings }` on success
// and `{ error }` otherwise.
export function resolveRemoteDestination(control) {
  const denied = (control.denies || []).find((d) => d.mode === 'remote');
  if (denied) {
    return { error: `remote mode is denied by ${denied.source} — a migration cannot override a deny` };
  }

  const conn = control.connection || {};
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
  if (kind === 'write-only') {
    // A write-only token is legitimate here — the writes will succeed — but the
    // classifying READ will 403, so every entry looks new. Say so up front
    // rather than presenting a plan that silently overstates the work.
    warnings.push(
      'token is write-only (lk_wo_*) — reads are denied, so every entry is reported as "add". '
      + 'The writes are still idempotent server-side.',
    );
  } else if (kind === 'unknown') {
    warnings.push('token has an unrecognized prefix (expected lk_rw_* / lk_ro_* / lk_wo_*) — proceeding anyway.');
  }

  return { store: createRemoteStore({ endpoint: conn.endpoint, token: conn.token }), warnings };
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
  if (remote) {
    const control = loadControl(root);
    const resolved = resolveRemoteDestination(control);
    if (resolved.error) {
      err(`${c.red('migrate:')} ${resolved.error}`);
      return 1;
    }
    remoteWarnings = resolved.warnings;
    targetFor = () => resolved.store;
    destLabel = `remote (${control.connection.endpoint})`;
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
  const pace = remote ? createPacer({ sleepFn: options.sleepFn }) : async () => {};
  const call = async (fn) => {
    await pace();
    if (!remote) return fn();
    return withRetry(fn, {
      sleepFn: options.sleepFn,
      onRetry: ({ attempt, delayMs }) =>
        status('warn', 'rate limit', `429 — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt})`),
    });
  };

  const totals = { add: 0, update: 0, noop: 0 };
  const byScope = new Map();
  let capped = null;
  let failed = 0;
  let ttlClamped = 0;
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
      current = await call(() => store.getEntry({ scope: entry.scope, key: entry.key }));
    } catch (e) {
      failed++;
      status('fail', entry.scope, `${entry.key}: ${e?.message || 'read failed'}`);
      continue;
    }
    let verdict;
    if (!current) verdict = 'add';
    else if (remote ? sameRemoteEntry(current, entry) : sameEntry(current, entry)) verdict = 'noop';
    else verdict = 'update';

    if (apply && verdict !== 'noop') {
      const res = await call(() => store.putEntry(entry));
      // The entry landed, but with a shorter life than it had: the hosted TTL
      // maxes out at 365 days. Counted so the summary can say so — a silently
      // shortened expiry is the kind of loss a user finds out about later.
      if (res && res.ttlClamped) ttlClamped++;
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
        continue; // not counted as migrated — the report must not claim it
      }
    }

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
  if (ttlClamped > 0) {
    log(`  ${ttlClamped} entr${ttlClamped === 1 ? 'y' : 'ies'} had a TTL longer than the hosted maximum — shortened to 365 days.`);
  }
  if (capped) {
    err(`\n${c.red('migrate:')} ${capped}`);
    log(`  ${moved} entr${moved === 1 ? 'y' : 'ies'} migrated before the cap was reached.`);
    log(`  ${c.dim('Archive unused memories or raise the plan limit, then re-run — the migration resumes where it stopped.')}`);
    return 1;
  }
  if (failed > 0) {
    // "failed", not "failed to write" — an entry lands here from an unreadable
    // classification as well as from a rejected write.
    err(`\n${c.red('migrate:')} ${failed} entr${failed === 1 ? 'y' : 'ies'} failed (listed above).`);
    return 1;
  }
  if (!apply && moved > 0) log(`  ${c.dim('Re-run with --yes to apply.')}`);
  return 0;
}
