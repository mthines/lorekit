// On-disk entry format for the local file store.
// Zero-dependency. An entry is a markdown file: a YAML frontmatter block whose
// scalars are JSON-encoded (a strict subset of YAML, so the file stays valid
// YAML and greppable) followed by the lesson body. This converges with the
// persistent-memory entry format (frontmatter + body) so a `.lore/` directory
// is interoperable — the frontmatter mirrors a LoreKit row's columns and the
// body is the row's `value`.
import path from 'node:path';

// The frontmatter columns, in a stable order. `value` is the body, not a column.
export const FIELDS = [
  'scope',
  'key',
  'tags',
  'source_agent',
  'trigger',
  'created',
  'updated',
  'archived_at',
];

// Serialize an entry ({ ...columns, value }) into file text.
export function serializeEntry(entry) {
  const fm = FIELDS.map((k) => `${k}: ${JSON.stringify(entry[k] ?? null)}`).join('\n');
  const body = entry.value == null ? '' : String(entry.value);
  return `---\n${fm}\n---\n${body}\n`;
}

// Parse file text back into an entry, or null when it has no frontmatter.
// Values are JSON-decoded; a hand-edited non-JSON scalar falls back to raw text.
export function parseEntry(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    meta[key] = decode(line.slice(idx + 1).trim());
  }
  return { ...meta, value: m[2].replace(/\n$/, '') };
}

function decode(raw) {
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Filesystem-safe slug for a lesson key. The key stays authoritative in the
// frontmatter, so the slug only needs to be safe and readable, not reversible.
export function slugify(key) {
  const s = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || 'entry';
}

// Sanitize a single path segment (owner, repo, branch part).
function safeSeg(s) {
  const cleaned = String(s == null ? '' : s)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Neutralize dot-only segments ('.', '..', …): the char class above keeps
  // dots (so `my.repo` survives), but a bare `..` segment would let a crafted
  // scope traverse out of the store dir via path.join. Collapse those to '_'.
  if (/^\.+$/.test(cleaned)) return '_';
  return cleaned || '_';
}

// Map a canonical scope string to its directory under the store base.
//   global                          → <base>/global
//   project::{name}                 → <base>/project/{name}
//   repo::{owner}/{repo}            → <base>/repo/{owner}/{repo}
//   branch::{owner}/{repo}::{branch} → <base>/branch/{owner}/{repo}/{branch...}
export function scopeToDir(baseDir, scope) {
  const parts = String(scope).split('::');
  const type = parts[0];
  if (type === 'global') return path.join(baseDir, 'global');
  if (type === 'project') return path.join(baseDir, 'project', safeSeg(parts[1]));
  if (type === 'repo') {
    const [owner, repo] = String(parts[1] || '').split('/');
    return path.join(baseDir, 'repo', safeSeg(owner), safeSeg(repo));
  }
  if (type === 'branch') {
    const [owner, repo] = String(parts[1] || '').split('/');
    const branch = String(parts[2] || '')
      .split('/')
      .map(safeSeg);
    return path.join(baseDir, 'branch', safeSeg(owner), safeSeg(repo), ...branch);
  }
  return path.join(baseDir, '_other', safeSeg(String(scope).replace(/::/g, '-')));
}
