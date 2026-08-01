// `lorekit migrate --from <src> [--to <dest>] [--scope <s>] [--yes|--apply]`
//
// Moves memories between stores. Two modes, chosen by what `--from`/`--to` name:
//
//   1. Relocation (local → local): `--from <path>` reads a LoreKit-format local
//      store at <path> (e.g. an old `.lore/` dir, or a moved store) and
//      re-writes its entries into the resolved current-layout store(s)
//      (`--to home|project`, default = routed two-tier), so lessons are never
//      stranded by a rename or move. Upserts VERBATIM by scope+key (via
//      putEntry), including archived entries.
//
//   2. Cross-store (local ↔ remote): `--from local --to remote` pushes the
//      offline store up to the hosted service; `--from remote --to local` pulls
//      it down. `local` and `remote` are reserved keywords for the resolved
//      stores. Transfers via each store's public contract (listScopes + list +
//      write/putEntry), so only ACTIVE (non-archived, non-expired) memories
//      move. remote→local preserves created/updated/expires_at/origin verbatim;
//      local→remote preserves created_at + origin and converts a memory's
//      absolute expiry back to a remaining ttl_days (whole days), since the
//      hosted write API takes a relative TTL, not an absolute instant.
//
// Dry-run (preview) by default in both modes: it prints what would move, per
// scope, and changes nothing. Only `--yes` (or `--apply`) mutates. Idempotent.
//
// Out of scope: reading persistent-memory's `~/.agent-memory/<bucket>/INDEX.md`
// + `entries/` format. This tool only understands LoreKit's own on-disk format.
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRoot } from './config.mjs';
import { localStoreDirs } from './control.mjs';
import { resolveDenies } from './control.mjs';
import { resolveStores, remoteUnavailableReason } from './stores.mjs';
import { createLocalStore, createTwoTierStore } from './store/index.mjs';
import { parseEntry } from './store/format.mjs';
import { log, heading, status, err, c } from './util.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

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

export async function migrate(args) {
  const root = resolveProjectRoot(args.dir);

  const from = typeof args.from === 'string' ? args.from : null;
  const toRaw = typeof args.to === 'string' ? args.to.toLowerCase() : null;

  // Cross-store mode: --from / --to name the stores themselves (local | remote),
  // not a filesystem path or a local tier.
  if (isStoreKeyword(from) || isStoreKeyword(toRaw)) {
    return migrateCrossStore(args, root, from, toRaw);
  }

  if (!from) {
    err(`${c.red('migrate:')} --from <path> is required (the store to migrate from)`);
    return 1;
  }
  const src = path.isAbsolute(from) ? from : path.join(root, from);
  if (!fs.existsSync(src)) {
    err(`${c.red('migrate:')} source not found: ${src}`);
    return 1;
  }

  const to = toRaw;
  if (to && to !== 'home' && to !== 'project') {
    err(`${c.red('migrate:')} --to must be "home" or "project" (or use "local"/"remote" for a cross-store migrate)`);
    return 1;
  }
  const apply = Boolean(args.apply || args.yes);

  const dirs = localStoreDirs(root);

  // Resolve where each entry goes. `--to` forces a single tier; the default
  // routes each entry by scope through the two-tier store (global → home,
  // repo/branch → project when opted-in, else home).
  let targetFor;
  let destLabel;
  if (to === 'home') {
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

  const entries = collectEntries(src);

  heading('LoreKit migrate');
  log(`  from: ${c.dim(src)}`);
  log(`  to:   ${c.dim(destLabel)}`);
  log(`  mode: ${apply ? c.bold('apply') : 'dry-run — pass --yes to apply'}`);
  log(`  found: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}\n`);

  const totals = { add: 0, update: 0, noop: 0 };
  const byScope = new Map();
  for (const entry of entries) {
    const store = targetFor(entry.scope);
    const current = store.getEntry({ scope: entry.scope, key: entry.key });
    let verdict;
    if (!current) verdict = 'add';
    else if (sameEntry(current, entry)) verdict = 'noop';
    else verdict = 'update';

    totals[verdict]++;
    const s = byScope.get(entry.scope) || { add: 0, update: 0, noop: 0 };
    s[verdict]++;
    byScope.set(entry.scope, s);

    if (apply && verdict !== 'noop') await store.putEntry(entry);
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
  if (!apply && moved > 0) log(`  ${c.dim('Re-run with --yes to apply.')}`);
  return 0;
}

// ── Cross-store migrate (local ↔ remote) ──────────────────────────────────────

// `local` / `remote` are reserved --from/--to values that name a store rather
// than a path or a local tier.
export function isStoreKeyword(x) {
  return x === 'local' || x === 'remote';
}

// Normalize an entry from either store into the canonical fields the transfer
// needs. Local rows spell the timestamps `created`/`updated`; remote rows spell
// them `created_at`/`updated_at`. Everything else is column-identical.
export function readFields(e = {}) {
  return {
    scope: e.scope,
    key: e.key,
    value: e.value == null ? '' : String(e.value),
    tags: Array.isArray(e.tags) ? e.tags : [],
    source_agent: e.source_agent ?? null,
    trigger: e.trigger ?? null,
    created: e.created ?? e.created_at ?? null,
    updated: e.updated ?? e.updated_at ?? null,
    expires_at: e.expires_at ?? null,
    origin_repo: e.origin_repo ?? null,
    origin_branch: e.origin_branch ?? null,
    origin_commit: e.origin_commit ?? null,
    origin_pr: e.origin_pr ?? null,
  };
}

// Convert an absolute `expires_at` into the remaining whole `ttl_days` the
// hosted write API accepts (it takes a relative TTL, not an instant). Returns
// `{}` when there is no expiry or it has already elapsed (an elapsed row would
// not have been listed anyway), so the memory is written permanent rather than
// pre-expired. Capped at the API's 365-day ceiling.
export function ttlDaysFromExpiry(expiresAt, now) {
  if (!expiresAt) return {};
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return {};
  const days = Math.ceil((ms - now.getTime()) / DAY_MS);
  if (days < 1) return {};
  return { ttl_days: Math.min(days, 365) };
}

// Whether a destination entry already carries the same material content (value
// + tag set) as the source — the NOOP test. Timestamps and provenance are not
// compared: they legitimately differ across stores and a re-run must still
// settle to NOOP on unchanged content.
export function sameContent(dest, src) {
  if (!dest || !src) return false;
  if (String(dest.value ?? '') !== String(src.value ?? '')) return false;
  const dt = [...(dest.tags || [])].sort().join('\x00');
  const st = [...(src.tags || [])].sort().join('\x00');
  return dt === st;
}

// Enumerate every ACTIVE entry across every scope of a store, via its public
// contract. `listScopes()` shape differs by store (local returns the bare
// `[{ scope, count }]` array; remote returns `{ ok, scopes }`), so normalize it.
// Returns `{ ok, entries, error }`.
async function gatherStore(store, onlyScope = null) {
  // With --scope we already know the one scope to read, so skip the listScopes
  // enumeration entirely (a round-trip for a remote store); otherwise discover
  // every scope the store holds.
  let scopeNames;
  if (onlyScope) {
    scopeNames = [onlyScope];
  } else {
    const res = await store.listScopes();
    const scopes = Array.isArray(res) ? res : res && res.ok ? res.scopes : null;
    if (!scopes) {
      return { ok: false, entries: [], error: (res && res.error && res.error.message) || 'could not list scopes' };
    }
    scopeNames = scopes.map((s) => s.scope);
  }
  const entries = [];
  for (const scope of scopeNames) {
    // Page by cursor until the store reports no more. The remote caps a read at
    // 100 rows/request and continues via nextCursor; the local store returns
    // every row in one call and reports no `hasMore`, so the loop runs once —
    // the same call works for both, no per-store branch.
    let cursor = null;
    do {
      const listed = await store.list({ scope, cursor });
      if (!listed.ok) {
        return { ok: false, entries: [], error: (listed.error && listed.error.message) || `could not list ${scope}` };
      }
      for (const e of listed.entries || []) entries.push(readFields(e));
      cursor = listed.hasMore ? listed.nextCursor : null;
    } while (cursor);
  }
  return { ok: true, entries, error: null };
}

// Write one canonical entry to the destination. Local destinations use putEntry
// (verbatim: created/updated/expires_at/origin preserved exactly). Remote
// destinations use write() — the server stamps its own `updated`, and the
// absolute expiry is converted to a remaining ttl_days.
async function putToStore(dest, destKind, f, now) {
  // `f` is a full readFields() record and putEntry stores it verbatim (defaulting
  // the absent archived_at to null), so the fields are preserved exactly.
  if (destKind === 'local') return dest.putEntry(f);
  return dest.write({
    scope: f.scope,
    key: f.key,
    value: f.value,
    ...(f.tags.length ? { tags: f.tags } : {}),
    ...(f.source_agent ? { source_agent: f.source_agent } : {}),
    ...(f.trigger ? { trigger: f.trigger } : {}),
    ...(f.created ? { created_at: f.created } : {}),
    ...ttlDaysFromExpiry(f.expires_at, now),
    ...(f.origin_repo ? { origin_repo: f.origin_repo } : {}),
    ...(f.origin_branch ? { origin_branch: f.origin_branch } : {}),
    ...(f.origin_commit ? { origin_commit: f.origin_commit } : {}),
    ...(f.origin_pr ? { origin_pr: f.origin_pr } : {}),
  });
}

async function migrateCrossStore(args, root, from, to) {
  // Both sides must be store keywords, and exactly one must be `remote` — this
  // command moves memories BETWEEN the local and remote stores.
  if (!isStoreKeyword(from) || !isStoreKeyword(to)) {
    err(`${c.red('migrate:')} for a cross-store migrate, both --from and --to must be "local" or "remote"`);
    return 1;
  }
  if (from === to) {
    err(`${c.red('migrate:')} --from and --to are both "${from}" — nothing to move`);
    return 1;
  }

  const env = { ...process.env };
  if (args.store) env.LOREKIT_STORE = args.store;

  const { localDenied, remoteDenied } = resolveDenies(root, { env });
  const { local, remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });

  if (remoteDenied) {
    err(`${c.red('migrate:')} remote store is disabled by deny constraint (${remoteDenied.source})`);
    return 1;
  }
  if (localDenied) {
    err(`${c.red('migrate:')} local store is disabled by deny constraint (${localDenied.source})`);
    return 1;
  }
  if (!remote.usable()) {
    err(`${c.red('migrate:')} remote store is not configured — ${remoteUnavailableReason(connection)}`);
    return 1;
  }

  const sourceStore = from === 'remote' ? remote : local;
  const destStore = to === 'remote' ? remote : local;
  const apply = Boolean(args.apply || args.yes);
  const onlyScope = typeof args.scope === 'string' ? args.scope : null;

  heading('LoreKit migrate (cross-store)');
  log(`  from: ${c.dim(from)}`);
  log(`  to:   ${c.dim(to)}`);
  if (onlyScope) log(`  scope: ${c.dim(onlyScope)}`);
  log(`  mode: ${apply ? c.bold('apply') : 'dry-run — pass --yes to apply'}`);

  const gathered = await gatherStore(sourceStore, onlyScope);
  if (!gathered.ok) {
    err(`\n${c.red('migrate:')} could not read the ${from} store: ${gathered.error}`);
    return 1;
  }
  const entries = gathered.entries;
  log(`  found: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}\n`);

  // Snapshot the destination ONCE (same paginated gather), keyed by scope::key,
  // rather than a per-entry read — one page-sized read per scope instead of one
  // network round-trip per source entry. scope+key is unique, so an in-memory
  // lookup classifies add/update/noop exactly as a live read would.
  const destSnap = await gatherStore(destStore, onlyScope);
  if (!destSnap.ok) {
    err(`\n${c.red('migrate:')} could not read the ${to} store: ${destSnap.error}`);
    return 1;
  }
  const destByKey = new Map(destSnap.entries.map((e) => [`${e.scope}\x00${e.key}`, e]));

  const now = new Date();
  const totals = { add: 0, update: 0, noop: 0, failed: 0 };
  const byScope = new Map();
  for (const f of entries) {
    const existing = destByKey.get(`${f.scope}\x00${f.key}`) || null;
    let verdict;
    if (!existing) verdict = 'add';
    else if (sameContent(existing, f)) verdict = 'noop';
    else verdict = 'update';

    if (apply && verdict !== 'noop') {
      const written = await putToStore(destStore, to, f, now);
      if (!written || written.ok === false) {
        verdict = 'failed';
        status('fail', `${f.scope}::${f.key}`, (written && written.error && written.error.message) || 'write failed');
      }
    }

    totals[verdict]++;
    const s = byScope.get(f.scope) || { add: 0, update: 0, noop: 0, failed: 0 };
    s[verdict]++;
    byScope.set(f.scope, s);
  }

  for (const [scope, s] of byScope) {
    const parts = [`${s.add} add`, `${s.update} update`, `${s.noop} unchanged`];
    if (s.failed) parts.push(`${c.red(`${s.failed} failed`)}`);
    status('info', scope, parts.join(', '));
  }

  const moved = totals.add + totals.update;
  heading('Summary');
  log(
    `  ${apply ? 'migrated' : 'would migrate'} ${moved} entr${moved === 1 ? 'y' : 'ies'} ` +
      `(${totals.add} new, ${totals.update} updated), ${totals.noop} unchanged` +
      `${totals.failed ? `, ${c.red(`${totals.failed} failed`)}` : ''}.`,
  );
  if (!apply && moved > 0) log(`  ${c.dim('Re-run with --yes to apply.')}`);
  return totals.failed > 0 ? 1 : 0;
}
