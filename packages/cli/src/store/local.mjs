// Local file store: markdown lessons under a store directory (default
// `.lorekit/`). One file per scope+key. Implements the common store contract
// over the filesystem. Zero-dependency (node built-ins only).
//
// A `TwoTierStore` (below) composes two `LocalStore`s — a per-user `home` tier
// and an opt-in per-repo `project` tier — behind the same contract, so callers
// (`core/lessons`, `hook`, `doctor`, `migrate`) keep talking to one interface.
import fs from 'node:fs';
import path from 'node:path';
import { serializeEntry, parseEntry, slugify, scopeToDir } from './format.mjs';
import { normalizeCreatedAt } from './created-at.mjs';
import { isLive, resolveExpiresAt } from './ttl.mjs';
import { seenCountOf, withReadFields } from './entry-fields.mjs';

export function createLocalStore(baseDir) {
  return new LocalStore(baseDir);
}

class LocalStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.mode = 'local';
  }

  _dir(scope) {
    return scopeToDir(this.baseDir, scope);
  }

  _files(scope) {
    const dir = this._dir(scope);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter((n) => n.endsWith('.md')).map((n) => path.join(dir, n));
  }

  _readAll(scope) {
    const out = [];
    for (const file of this._files(scope)) {
      try {
        const entry = parseEntry(fs.readFileSync(file, 'utf8'));
        if (entry) out.push({ entry, file });
      } catch {
        // Skip an unreadable file rather than fail the whole listing.
      }
    }
    return out;
  }

  _findByKey(scope, key) {
    return this._readAll(scope).find((r) => r.entry.key === key) || null;
  }

  // Raw lookup by scope+key — returns the stored entry regardless of archived
  // state (unlike read(), which hides archived). Synchronous; used by migrate
  // to classify ADD / UPDATE / NOOP without reviving archived entries.
  getEntry({ scope, key } = {}) {
    const found = this._findByKey(scope, key);
    return found ? found.entry : null;
  }

  // list({ scope, tags, limit }) → { ok, entries } — newest-first, tag-filtered,
  // archived hidden, expired hidden (lazily, mirroring the remote read paths).
  async list({ scope, tags, limit } = {}) {
    const now = new Date();
    let rows = this._readAll(scope)
      .map((r) => r.entry)
      .filter((e) => isLive(e, now));
    if (Array.isArray(tags) && tags.length) {
      rows = rows.filter((e) => tags.every((t) => (e.tags || []).includes(t)));
    }
    rows.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    if (limit) rows = rows.slice(0, limit);
    // The same additive projection the remote store applies, so a caller that
    // ranks entries never has to ask which store produced them.
    return { ok: true, entries: rows.map(withReadFields) };
  }

  // read({ scope, key }) → { ok, entry } — null when absent, archived, or expired.
  async read({ scope, key } = {}) {
    const found = this._findByKey(scope, key);
    return {
      ok: true,
      entry: found && isLive(found.entry) ? withReadFields(found.entry) : null,
    };
  }

  // write(...) → { ok, entry } — upsert by scope+key. Preserves `created` and
  // refreshes `updated`; writing an archived key revives it.
  //
  // `created_at` is an optional ISO 8601 override for migrating a pre-existing
  // memory (mirrors the hosted memory.write param). It applies only when the
  // entry is first created — on both `created` and `updated`, so a migrated
  // memory is dated by its original time everywhere — and is ignored for an
  // existing key (a creation date never moves). Returns { ok:false, error } on
  // an invalid or future-dated value rather than throwing, matching the store
  // contract's error surfacing.
  async write({
    scope, key, value, tags, source_agent, trigger, created_at, ttl_days, clear_ttl,
    origin_repo, origin_branch, origin_commit, origin_pr,
  } = {}) {
    const now = new Date().toISOString();
    const existing = this._findByKey(scope, key);
    let override, expires_at;
    try {
      override = normalizeCreatedAt(created_at);
      expires_at = resolveExpiresAt({
        clearTtl: clear_ttl, ttlDays: ttl_days, now, current: existing?.entry.expires_at,
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const dir = this._dir(scope);
    fs.mkdirSync(dir, { recursive: true });
    const created = existing ? existing.entry.created || now : override || now;
    const entry = {
      scope,
      key,
      tags: Array.isArray(tags) ? tags : [],
      source_agent: source_agent || null,
      trigger: trigger || null,
      // Provenance keeps the last KNOWN value per field, mirroring the hosted
      // memory_write upsert: a write that does not know a field must not erase
      // what a previous write recorded.
      origin_repo: origin_repo ?? existing?.entry.origin_repo ?? null,
      origin_branch: origin_branch ?? existing?.entry.origin_branch ?? null,
      origin_commit: origin_commit ?? existing?.entry.origin_commit ?? null,
      origin_pr: origin_pr ?? existing?.entry.origin_pr ?? null,
      created,
      updated: existing ? now : override || now,
      archived_at: null,
      expires_at,
      // Recurrence, counted the way the hosted `memory_write` RPC counts it
      // (migration 00059): a write against a key this store already holds IS
      // the next sighting. `seenCountOf` floors an absent/hand-edited value to
      // 0, so a file written before this column existed resumes at 1 on its
      // next write rather than throwing or restarting the tally at 2.
      //
      // Reviving an ARCHIVED entry restarts at 1, matching the hosted RPC.
      // An EXPIRED-but-unarchived entry does NOT: `_findByKey` ignores expiry,
      // so the file is still found and the tally continues. That asymmetry is
      // deliberate and mirrors the hosted side — every conflict predicate is
      // partial on `archived_at is null` only, so an expired row is still the
      // upsert target and its count still climbs. Expiry hides a lesson from
      // reads; archiving retires it.
      // The two stores get there differently — every conflict predicate on
      // `memories` is partial on `archived_at is null`, so the server INSERTS a
      // fresh row, while this store revives the file in place (see the docblock
      // above) — but the count means the same thing on both: the lesson was
      // retired and is being learned again, not seen once more.
      seen_count: existing && !existing.entry.archived_at
        ? seenCountOf(existing.entry) + 1
        : 1,
      value: value == null ? '' : String(value),
    };
    const file = existing ? existing.file : this._freshPath(dir, key);
    fs.writeFileSync(file, serializeEntry(entry));
    return { ok: true, entry };
  }

  // putEntry(entry) — verbatim upsert by scope+key. Unlike write(), it does NOT
  // synthesize timestamps or clear archived_at: every field of the given entry
  // is preserved as-is. This is the lossless primitive migrate uses to relocate
  // a store (including archived entries) idempotently.
  async putEntry(entry = {}) {
    const scope = entry.scope;
    const dir = this._dir(scope);
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const existing = this._findByKey(scope, entry.key);
    const full = {
      scope,
      key: entry.key,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      source_agent: entry.source_agent ?? null,
      trigger: entry.trigger ?? null,
      origin_repo: entry.origin_repo ?? null,
      origin_branch: entry.origin_branch ?? null,
      origin_commit: entry.origin_commit ?? null,
      origin_pr: entry.origin_pr ?? null,
      created: entry.created ?? now,
      updated: entry.updated ?? now,
      archived_at: entry.archived_at ?? null,
      expires_at: entry.expires_at ?? null,
      // Verbatim, like every field here: migrate relocates a store, it does not
      // re-sight its lessons, so a relocated entry must keep the count it had.
      // An entry that never carried one lands as null and reads back as 0.
      seen_count: entry.seen_count ?? null,
      value: entry.value == null ? '' : String(entry.value),
    };
    const file = existing ? existing.file : this._freshPath(dir, entry.key);
    fs.writeFileSync(file, serializeEntry(full));
    return { ok: true, entry: full };
  }

  _freshPath(dir, key) {
    const base = slugify(key);
    let name = `${base}.md`;
    let i = 2;
    while (fs.existsSync(path.join(dir, name))) name = `${base}-${i++}.md`;
    return path.join(dir, name);
  }

  // delete({ scope, key, force }) — force removes the file; soft-delete archives.
  async delete({ scope, key, force } = {}) {
    const found = this._findByKey(scope, key);
    if (!found) return { ok: true, deleted: false };
    if (force) {
      try {
        fs.unlinkSync(found.file);
      } catch {
        // Already gone — treat as deleted.
      }
      return { ok: true, deleted: true };
    }
    return this.archive({ scope, key });
  }

  async archive({ scope, key } = {}) {
    return this._setArchived(scope, key, new Date().toISOString());
  }

  async restore({ scope, key } = {}) {
    return this._setArchived(scope, key, null);
  }

  _setArchived(scope, key, ts) {
    const found = this._findByKey(scope, key);
    if (!found) return { ok: true, archived: false };
    const entry = { ...found.entry, archived_at: ts, updated: new Date().toISOString() };
    fs.writeFileSync(found.file, serializeEntry(entry));
    return { ok: true, archived: ts != null, entry };
  }

  // search({ q, scopes, tags }) → { ok, entries } — keyword over key/tags/body.
  // `q` is a single needle (string) OR a list of needles (string[]); a list
  // matches an entry when ANY needle is a substring (OR semantics). Either way
  // this walks each scope EXACTLY ONCE — the failure hook passes all its terms
  // in one call rather than one call per term, so N terms no longer re-read the
  // store N times. An empty query (or empty list) returns everything, unchanged.
  async search({ q, scopes, tags } = {}) {
    const needles = (Array.isArray(q) ? q : [q])
      .map((n) => String(n || '').toLowerCase())
      .filter(Boolean);
    const matchAll = needles.length === 0;
    const out = [];
    for (const scope of scopes || []) {
      const { entries } = await this.list({ scope, tags });
      for (const e of entries) {
        const hay = `${e.key}\n${(e.tags || []).join(' ')}\n${e.value || ''}`.toLowerCase();
        if (matchAll || needles.some((n) => hay.includes(n))) out.push(e);
      }
    }
    return { ok: true, entries: out };
  }

  // Total non-archived entries across the given scopes (doctor uses this).
  async count(scopes) {
    let n = 0;
    for (const scope of scopes || []) n += (await this.list({ scope })).entries.length;
    return n;
  }

  // Recursively collect every parsed entry under baseDir, across ALL scopes —
  // the primitive `listScopes()` builds on. Best-effort: a missing base dir or
  // an unreadable file is skipped, never thrown. Reads each file's frontmatter
  // (the authoritative scope string) rather than the directory it sits in.
  _walkEntries() {
    const out = [];
    const walk = (dir) => {
      let dirents;
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // missing / unreadable directory — nothing to enumerate here
      }
      for (const d of dirents) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          walk(full);
        } else if (d.isFile() && d.name.endsWith('.md')) {
          try {
            const entry = parseEntry(fs.readFileSync(full, 'utf8'));
            if (entry) out.push({ entry, file: full });
          } catch {
            // Skip an unreadable file rather than fail the whole enumeration.
          }
        }
      }
    };
    walk(this.baseDir);
    return out;
  }

  // Enumerate every distinct scope present on disk with its non-archived lesson
  // count — a STORE-WIDE inventory, independent of any current directory (unlike
  // list/count, which take an explicit scope set). The scope of each lesson is
  // read from its frontmatter `scope` field, so the reconstructed scope string
  // is EXACT — never reverse-mapped from the on-disk directory layout, which is
  // lossy for `project::{name}` (stored by basename only). Returns
  // `[{ scope, count }]`, unsorted.
  async listScopes() {
    const now = new Date();
    const counts = new Map();
    for (const { entry } of this._walkEntries()) {
      if (!entry.scope || !isLive(entry, now)) continue;
      counts.set(entry.scope, (counts.get(entry.scope) || 0) + 1);
    }
    return [...counts.entries()].map(([scope, count]) => ({ scope, count }));
  }
}

// A scope string is global when its type segment is `global`.
function isGlobalScope(scope) {
  return String(scope).split('::')[0] === 'global';
}

// Union two entry lists, keyed by `keyFn`. The first list (winners) shadows the
// second (losers) on a key collision — so passing the project tier first makes
// the closer scope win, mirroring the remote narrow→broad merge in fetchLessons.
function mergeByKey(winners, losers, keyFn) {
  const seen = new Set();
  const out = [];
  for (const list of [winners, losers]) {
    for (const e of list) {
      const k = keyFn(e);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

export function createTwoTierStore({ home, project } = {}) {
  return new TwoTierStore({ home, project });
}

// Two-tier local store: a per-user `home` tier (always available) and an opt-in
// per-repo `project` tier (active only when its directory exists). Presents the
// same contract as a single LocalStore:
//   - reads (list / read / search) union both tiers, project shadowing home;
//   - writes route by scope — global → home, everything else → project when
//     opted-in, else home;
//   - delete / archive / restore act on the tier that holds the visible entry
//     (project first, then home).
class TwoTierStore {
  constructor({ home, project } = {}) {
    this.mode = 'local';
    this.homeDir = home;
    this.projectDir = project || null;
    this.home = new LocalStore(home);
    this.project = this.projectDir ? new LocalStore(this.projectDir) : null;
  }

  // The project tier is opted-in when its directory exists (checked live, so a
  // freshly-created `.lorekit/` or a migrate --to project takes effect at once).
  projectActive() {
    return Boolean(this.project && this.projectDir && fs.existsSync(this.projectDir));
  }

  // The LocalStore a write for `scope` should target.
  tierFor(scope) {
    if (isGlobalScope(scope)) return this.home;
    return this.projectActive() ? this.project : this.home;
  }

  async list({ scope, tags, limit } = {}) {
    const homeRes = await this.home.list({ scope, tags });
    const projRes = this.projectActive()
      ? await this.project.list({ scope, tags })
      : { entries: [] };
    const merged = mergeByKey(projRes.entries, homeRes.entries, (e) => e.key);
    merged.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    return { ok: true, entries: limit ? merged.slice(0, limit) : merged };
  }

  async read({ scope, key } = {}) {
    if (this.projectActive()) {
      const r = await this.project.read({ scope, key });
      if (r.entry) return r;
    }
    return this.home.read({ scope, key });
  }

  // A write goes to ONE tier — the tier `scope` resolves to — and never reads
  // the other. So `seen_count` is counted PER TIER: opting a repo into a
  // project tier makes the first write of an already-home-held key a fresh
  // entry there, restarting its tally at 1 while the home copy keeps its own.
  // That follows from tiering rather than contradicting it (`list`/`read` let
  // the project tier SHADOW home rather than merging the two rows), and the
  // alternative — seeding the count from the tier being shadowed — would make
  // a write depend on a row it is not writing. Use `lorekit migrate --from
  // ~/.lorekit --to project` to carry an existing tally across; that relocates
  // counts verbatim. `--from <path>` is required — it names the store to read.
  async write(args = {}) {
    return this.tierFor(args.scope).write(args);
  }

  async putEntry(entry = {}) {
    return this.tierFor(entry.scope).putEntry(entry);
  }

  async delete({ scope, key, force } = {}) {
    if (this.projectActive()) {
      const r = await this.project.delete({ scope, key, force });
      if (r.deleted || r.archived) return r;
    }
    return this.home.delete({ scope, key, force });
  }

  async archive({ scope, key } = {}) {
    if (this.projectActive()) {
      const r = await this.project.archive({ scope, key });
      if (r.entry) return r;
    }
    return this.home.archive({ scope, key });
  }

  async restore({ scope, key } = {}) {
    if (this.projectActive()) {
      const r = await this.project.restore({ scope, key });
      if (r.entry) return r;
    }
    return this.home.restore({ scope, key });
  }

  async search({ q, scopes, tags } = {}) {
    const homeRes = await this.home.search({ q, scopes, tags });
    const projRes = this.projectActive()
      ? await this.project.search({ q, scopes, tags })
      : { entries: [] };
    const merged = mergeByKey(projRes.entries, homeRes.entries, (e) => `${e.scope}\x00${e.key}`);
    return { ok: true, entries: merged };
  }

  // Merged, de-duplicated non-archived count across the given scopes.
  async count(scopes) {
    let n = 0;
    for (const scope of scopes || []) n += (await this.list({ scope })).entries.length;
    return n;
  }

  // Store-wide scope inventory across both tiers, de-duplicated by scope+key so
  // a lesson present in both tiers is counted once — project shadows home, the
  // same first-wins merge `list()` uses. Returns `[{ scope, count }]`, unsorted.
  async listScopes() {
    const now = new Date();
    const seen = new Set(); // `${scope}\x00${key}` — dedup across tiers
    const counts = new Map();
    const tiers = this.projectActive() ? [this.project, this.home] : [this.home];
    for (const tier of tiers) {
      for (const { entry } of tier._walkEntries()) {
        if (!entry.scope || !isLive(entry, now)) continue;
        const id = `${entry.scope}\x00${entry.key ?? ''}`;
        if (seen.has(id)) continue;
        seen.add(id);
        counts.set(entry.scope, (counts.get(entry.scope) || 0) + 1);
      }
    }
    return [...counts.entries()].map(([scope, count]) => ({ scope, count }));
  }
}
