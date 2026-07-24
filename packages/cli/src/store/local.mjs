// Local file store: markdown lessons under a store directory (default `.lore/`).
// One file per scope+key. Implements the common store contract over the
// filesystem. Zero-dependency (node built-ins only).
import fs from 'node:fs';
import path from 'node:path';
import { serializeEntry, parseEntry, slugify, scopeToDir } from './format.mjs';

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

  // list({ scope, tags, limit }) → { ok, entries } — newest-first, tag-filtered,
  // archived hidden.
  async list({ scope, tags, limit } = {}) {
    let rows = this._readAll(scope)
      .map((r) => r.entry)
      .filter((e) => !e.archived_at);
    if (Array.isArray(tags) && tags.length) {
      rows = rows.filter((e) => tags.every((t) => (e.tags || []).includes(t)));
    }
    rows.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    if (limit) rows = rows.slice(0, limit);
    return { ok: true, entries: rows };
  }

  // read({ scope, key }) → { ok, entry } — null when absent or archived.
  async read({ scope, key } = {}) {
    const found = this._findByKey(scope, key);
    const entry = found && !found.entry.archived_at ? found.entry : null;
    return { ok: true, entry };
  }

  // write(...) → { ok, entry } — upsert by scope+key. Preserves `created` and
  // refreshes `updated`; writing an archived key revives it.
  async write({ scope, key, value, tags, source_agent, trigger } = {}) {
    const dir = this._dir(scope);
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const existing = this._findByKey(scope, key);
    const entry = {
      scope,
      key,
      tags: Array.isArray(tags) ? tags : [],
      source_agent: source_agent || null,
      trigger: trigger || null,
      created: existing ? existing.entry.created || now : now,
      updated: now,
      archived_at: null,
      value: value == null ? '' : String(value),
    };
    const file = existing ? existing.file : this._freshPath(dir, key);
    fs.writeFileSync(file, serializeEntry(entry));
    return { ok: true, entry };
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
  async search({ q, scopes, tags } = {}) {
    const needle = String(q || '').toLowerCase();
    const out = [];
    for (const scope of scopes || []) {
      const { entries } = await this.list({ scope, tags });
      for (const e of entries) {
        const hay = `${e.key}\n${(e.tags || []).join(' ')}\n${e.value || ''}`.toLowerCase();
        if (!needle || hay.includes(needle)) out.push(e);
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
}
