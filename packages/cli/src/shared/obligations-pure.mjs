// Pure, DEPENDENCY-FREE matcher for the Surface-Partner Map (`obligations-map.mjs`).
//
// The problem this solves: a fix to one surface (a mirrored module, a doc that
// copies a claim, a generated artifact) routinely leaves its PARTNER surface
// stale, because the ~45 memory lessons documenting each known partnership are
// retrieved lexically (FTS + recency) and never surface at edit time for a
// specific file. Since the recurrences are known, PATH-KEYED file
// partnerships, a deterministic path-keyed check beats search — this module is
// that check.
//
// Zero imports on purpose (mirrors `lessons-pure.mjs`) and NEVER touches the
// filesystem or `process.cwd()` — see the module-level note in
// `obligations-map.mjs`. It matches the path STRINGS it is given against the
// map; the IO shell (`commands/obligations.mjs`) resolves those strings from
// argv/stdin.
//
// ── the `{name}` placeholder ────────────────────────────────────────────────
//
// A `match`/`obliges` glob may contain the literal token `{name}` to bind the
// module's relative path (directories + file stem, extension stripped) so a
// generic partnership (`edge-mirror`) doesn't need one map entry per module.
// The token is recognised in two shapes:
//
//   `**/{name}`  — ONE capturing group spanning zero or more path segments
//                  AND the final stem, e.g. `src/**/{name}.ts` captures
//                  `audit/audit` out of `src/audit/audit.ts`, for reuse in a
//                  partner pattern's own `**/{name}` slot. This ONLY works
//                  when the partner's directory structure is a predictable
//                  function of the source's — e.g. `docs-section`'s
//                  `sections.ts` entry needs no name at all, so it's not used
//                  there either. It is NOT used by the seed map's
//                  `edge-mirror`/`edge-mirror-core` entries (see
//                  `obligations-map.mjs`): a real edge (Deno) mirror does not
//                  reliably preserve mcp-core's directory structure — it may
//                  flatten or rename it — so those two entries instead
//                  enumerate every KNOWN pair's exact partner from a
//                  single-source inventory (`mirror-pairs.mjs`) rather than
//                  reconstruct a partner path via substitution. The token
//                  remains available here as a general primitive for any
//                  future map entry whose partner path genuinely IS a
//                  predictable function of the source's.
//   `{name}`     — a single-segment capturing group (no preceding `**/`) for
//                  a flat `{name}.ext` match with no directory component.
//
// `stemOf` (below) is the simpler, general-purpose primitive — a plain
// basename-without-extension — exported for standalone use and unit testing.

export const RUN_PREFIX = 'run:';
export const REGEX_PREFIX = 're:';

const NAME_TOKEN = '{name}';
const DIR_NAME_TOKEN = `**/${NAME_TOKEN}`;

// Basename of `path`, extension stripped. A leading-dot file (`.env`) is its
// own stem (no extension to strip) rather than an empty string.
export function stemOf(path) {
  const base = String(path ?? '').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// Escape one character for literal inclusion in a RegExp source string.
function escapeChar(ch) {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

// Compile a single glob/regex pattern string into `{ regex, capturesName }`.
// `re:`-prefixed patterns are used verbatim (already anchored by the author,
// per the seed map's `docs-section`/`perf-index` entries) and never capture a
// name. Anything else is compiled token-by-token: `**/{name}` and bare
// `{name}` become the ONE capturing group a pattern may have, `**` becomes
// `.*`, `*` becomes `[^/]*`, and every other character is escaped literally.
// Returns null for a non-string / empty pattern, never throws.
export function compilePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern) return null;
  if (pattern.startsWith(REGEX_PREFIX)) {
    try {
      return { regex: new RegExp(pattern.slice(REGEX_PREFIX.length)), capturesName: false };
    } catch {
      return null;
    }
  }
  let src = '';
  let capturesName = false;
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith(DIR_NAME_TOKEN, i)) {
      src += '(.+)';
      capturesName = true;
      i += DIR_NAME_TOKEN.length;
    } else if (pattern.startsWith(NAME_TOKEN, i)) {
      src += '([^/]+)';
      capturesName = true;
      i += NAME_TOKEN.length;
    } else if (pattern.startsWith('**', i)) {
      src += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      src += '[^/]*';
      i += 1;
    } else {
      src += escapeChar(pattern[i]);
      i += 1;
    }
  }
  return { regex: new RegExp(`^${src}$`), capturesName };
}

// Compile `glob` into a plain, non-capturing-aware `RegExp` — the general
// membership test used both to check whether a changed file satisfies a
// (post-substitution) oblige target, and by tests exercising the glob syntax
// in isolation. Same token grammar as `compilePattern`; a `{name}` left
// unsubstituted (never expected once `checkObligations` has run) simply
// compiles to its capturing form, still usable as a plain matcher.
export function globToRegExp(glob) {
  return compilePattern(glob)?.regex ?? null;
}

// Replace the pattern's name placeholder with a captured value. `**/{name}`
// is replaced as ONE unit (so the substitution reconstructs a full relative
// path, matching how `compilePattern` captured it); a bare `{name}` is
// replaced on its own. `name == null` (no capture in the matching `match`
// pattern) returns `pattern` unchanged — nothing to substitute.
export function substituteName(pattern, name) {
  if (name == null || typeof pattern !== 'string') return pattern;
  if (pattern.includes(DIR_NAME_TOKEN)) return pattern.split(DIR_NAME_TOKEN).join(name);
  if (pattern.includes(NAME_TOKEN)) return pattern.split(NAME_TOKEN).join(name);
  return pattern;
}

// Does `file` satisfy `globPattern` (post-substitution, so no `{name}` token
// remains, but `**`/`*` wildcards may)? Compiles and tests in one step; an
// uncompilable pattern never matches.
function fileSatisfies(file, globPattern) {
  const regex = globToRegExp(globPattern);
  return regex ? regex.test(file) : false;
}

// Fold one `obliges` element into `bucket` (a `Map<target, row>` keyed by the
// rendered target string, so repeated matches — several changed files hitting
// the same entry — dedupe by the concrete, substituted target rather than by
// raw template).
//
// An element is one of:
//   `run:<action>`        — advisory, `kind:'action'`, `met: null`, never
//                            gates `--strict`.
//   a string               — a single required path/glob, `kind:'path'`.
//   an array of strings    — an "any of" group: the obligation is met if ANY
//                            candidate is present in `changedFiles` (for a
//                            partner that could legitimately live in more
//                            than one place). Rendered as one row whose
//                            `target` joins every candidate with ` OR `,
//                            `met` true iff any candidate matches. The seed
//                            map's `edge-mirror`/`edge-mirror-core` entries do
//                            NOT use this — see `obligations-map.mjs` — since
//                            enumerating each known pair's exact partner from
//                            `mirror-pairs.mjs` needs no "either of" guess.
// A row already present for the same rendered target has its `met` OR'd in
// (never downgraded from true to false by a later, differently-named match).
function addOblige(bucket, rawOblige, name, changedFiles) {
  if (typeof rawOblige === 'string' && rawOblige.startsWith(RUN_PREFIX)) {
    if (!bucket.has(rawOblige)) bucket.set(rawOblige, { target: rawOblige, kind: 'action', met: null });
    return;
  }
  const candidates = (Array.isArray(rawOblige) ? rawOblige : [rawOblige])
    .filter((c) => typeof c === 'string' && c);
  if (candidates.length === 0) return;
  const substituted = candidates.map((c) => substituteName(c, name));
  const met = substituted.some((c) => changedFiles.some((f) => fileSatisfies(f, c)));
  const target = substituted.join(' OR ');
  const existing = bucket.get(target);
  if (existing) existing.met = existing.met || met;
  else bucket.set(target, { target, kind: 'path', met });
}

/**
 * Check a changed-file set against the Surface-Partner Map. For every
 * `(file, entry)` pair where `file` satisfies one of `entry.match`'s
 * patterns, the entry is recorded as matched and its `obliges` are resolved
 * (with `{name}` substituted from whatever the matching pattern captured) and
 * checked for membership in `changedFiles`. Entries are deduped by `id` — a
 * file set can hit the same entry via several files, and each contributes its
 * own name-substituted targets into that one entry's `obliges` list.
 *
 * Pure and total: a malformed `map`/`changedFiles` degrades to no matches
 * rather than throwing.
 *
 * Returns `{ files, matched, unmet, ok }` — see `obligations-map.mjs`'s
 * schema docblock for the shape of each `matched` entry.
 */
export function checkObligations({ changedFiles = [], map = [] } = {}) {
  const files = Array.isArray(changedFiles)
    ? changedFiles.filter((f) => typeof f === 'string' && f.length > 0)
    : [];
  const entries = Array.isArray(map) ? map : [];

  const byId = new Map(); // id -> { id, lessonKey, guard, note, obliges: Map<target, row> }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !entry.id) continue;
    const patterns = Array.isArray(entry.match) ? entry.match : [entry.match];

    for (const file of files) {
      let matched = false;
      let name = null;
      for (const pattern of patterns) {
        const compiled = compilePattern(pattern);
        if (!compiled) continue;
        const m = compiled.regex.exec(file);
        if (m) {
          matched = true;
          if (compiled.capturesName) name = m[1];
          break;
        }
      }
      if (!matched) continue;

      let bucket = byId.get(entry.id);
      if (!bucket) {
        bucket = {
          id: entry.id,
          lessonKey: entry.lessonKey ?? null,
          guard: entry.guard ?? null,
          note: entry.note ?? null,
          obliges: new Map(),
        };
        byId.set(entry.id, bucket);
      }
      for (const rawOblige of Array.isArray(entry.obliges) ? entry.obliges : []) {
        addOblige(bucket.obliges, rawOblige, name, files);
      }
    }
  }

  const matched = [...byId.values()].map((b) => ({
    id: b.id,
    lessonKey: b.lessonKey,
    guard: b.guard,
    note: b.note,
    obliges: [...b.obliges.values()],
  }));

  const unmet = matched.reduce((n, e) => n + e.obliges.filter((o) => o.met === false).length, 0);

  return { files, matched, unmet, ok: unmet === 0 };
}
