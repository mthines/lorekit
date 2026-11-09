// On-disk entry format for the local file store.
// Zero-dependency. An entry is a markdown file: a YAML frontmatter block whose
// scalars are JSON-encoded (a strict subset of YAML, so the file stays valid
// YAML and greppable) followed by the lesson body. This converges with the
// persistent-memory entry format (frontmatter + body) so a `.lorekit/` directory
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
  // Provenance — where the lesson was recorded FROM (see src/origin.mjs).
  // Appended, never reordered: parseEntry is tolerant, so a file written before
  // these existed simply decodes them as absent.
  'origin_repo',
  'origin_branch',
  'origin_commit',
  'origin_pr',
  // Expiry — the absolute ISO instant this lesson auto-expires (see src/store/
  // ttl.mjs). Null / absent means it never expires. Appended like the origin
  // columns: a file written before this existed simply decodes it as absent.
  'expires_at',
  // Recurrence — how many times this lesson has been written, mirroring the
  // hosted `memories.seen_count` column (migration 00059) so an offline store
  // carries the same salience signal a remote one does. Appended like the
  // columns above: a file written before this existed decodes it as absent,
  // which the read projection reports as 0 rather than inventing a count.
  'seen_count',
  // Taxonomy — `kind` ('lesson'/'bus'/'signal') and `host` (which agent loop
  // wrote it), mirroring the hosted `memories.kind`/`memories.host` columns.
  // Appended like the columns above: a file written before these existed
  // decodes them as absent, which `normalizeEntry` in lessons-view.mjs falls
  // back to inferring from tags for, same as an absent remote value.
  'kind',
  'host',
  // Record extensions (migration 00119), mirroring the hosted columns.
  //   id            a uuid minted on the first write and kept on every rewrite —
  //                 the record's identity, independent of its scope::key address
  //   attributes    open map of namespaced keys to scalar values
  //   content_type  null (= text/markdown) or 'application/json'
  //   supersedes    the id of the record this one replaces
  // Appended like the columns above.
  'id',
  'attributes',
  'content_type',
  'supersedes',
  // Version (migration 00120): starts at 1 and goes up by one on every content
  // change — value, content_type, attributes, tags, or a new supersedes link —
  // mirroring the hosted `memories_bump_version` trigger. Appended like the
  // columns above: a file written before it existed reads as version 1.
  'version',
];

// The content types a record may declare; the first is what null means. The
// local twin of the hosted `memories_content_type_known` constraint.
export const CONTENT_TYPES = ['text/markdown', 'application/json'];

// Frontmatter fields this version does not know: written by a newer CLI, by
// another tool sharing the directory, or by hand. Carried through every rewrite
// so the file format is lossless — a field LoreKit does not understand is not
// LoreKit's to drop.
export function extraFields(entry) {
  const out = {};
  if (!entry) return out;
  for (const [k, v] of Object.entries(entry)) {
    if (k !== 'value' && !FIELDS.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}

// Merge an attributes write into what is stored, the way the hosted
// `memory_write` does: named keys are replaced, a null value removes its key,
// and keys the write does not name are kept.
export function mergeAttributes(stored, incoming) {
  const merged = { ...(isPlainObject(stored) ? stored : {}), ...(incoming || {}) };
  for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
  return merged;
}

// The local store's gate on the record extensions: the same shape rules the
// server's shared parser (packages/mcp-core/src/provenance/record-extensions.ts)
// applies. A twin rather than an import because the CLI is zero-dependency.
// One server rule has no offline equivalent: the hosted store also rejects a
// `supersedes` id it cannot find, while a local store cannot know ids that live
// elsewhere, so it accepts any well-formed one. Returns an error message, or null.
const ATTRIBUTE_KEY_RE = /^[a-z0-9_]+(?:[.-][a-z0-9_]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ATTRIBUTES_MAX_KEYS = 32;
const ATTRIBUTE_KEY_MAX = 128;
const ATTRIBUTE_VALUE_MAX = 1024;

export function recordFieldsIssue({ attributes, content_type, supersedes, value }) {
  if (attributes != null) {
    if (!isPlainObject(attributes)) return 'attributes must be an object of key/value pairs';
    if (Object.keys(attributes).length > ATTRIBUTES_MAX_KEYS) {
      return `attributes must have <= ${ATTRIBUTES_MAX_KEYS} keys`;
    }
    for (const [k, v] of Object.entries(attributes)) {
      if (k.length > ATTRIBUTE_KEY_MAX || !ATTRIBUTE_KEY_RE.test(k)) {
        return `attribute key must be lowercase and dot-separated (e.g. "ci.run_url"), <= ${ATTRIBUTE_KEY_MAX} characters: ${k}`;
      }
      if (typeof v === 'number' && !Number.isFinite(v)) return `attribute ${k} must be a finite number`;
      if (typeof v === 'string' && v.length > ATTRIBUTE_VALUE_MAX) {
        return `attribute ${k} must be <= ${ATTRIBUTE_VALUE_MAX} characters`;
      }
      if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
        return `attribute ${k} must be a string, number, boolean, or null`;
      }
    }
  }
  if (content_type != null && !CONTENT_TYPES.includes(content_type)) {
    return `content_type must be one of ${CONTENT_TYPES.join(', ')}: ${content_type}`;
  }
  if (content_type === 'application/json') {
    try {
      JSON.parse(value);
    } catch {
      return 'value must be valid JSON when content_type is application/json';
    }
  }
  if (supersedes != null && !UUID_RE.test(supersedes)) {
    return `supersedes must be a memory id (uuid): ${supersedes}`;
  }
  return null;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Serialize an entry ({ ...columns, value }) into file text.
//
// Known fields come first, in FIELDS order; any field this version does not know
// follows, in the order it was read, so a rewrite never drops it.
export function serializeEntry(entry) {
  const known = FIELDS.map((k) => `${k}: ${JSON.stringify(entry[k] ?? null)}`);
  const extra = Object.entries(extraFields(entry)).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  const fm = [...known, ...extra].join('\n');
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
