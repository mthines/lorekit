// Shared hook logic: fetch and format lessons; build the nudge text.
// Framework-agnostic — adapters shape these strings into each tool's contract.
// Storage is reached through the resolved store (local | remote), never a
// backend directly, so the same read path serves every mode.
import { deriveScope } from '../scope.mjs';
// The precedence merge and the literal substring matcher come from the
// dependency-free `lessons-pure.mjs` — the SAME primitives `tree` and `search`
// use, so the hook can't drift from them, and the hot path never pulls in the
// `lessons-view.mjs` render/`util` stack.
import { resolvePrecedence, matchesQuery } from '../lessons-pure.mjs';

const MAX_LESSONS = 15;
// Cap on lessons injected on a failure — a small, focused "you've seen this
// before" set, never the whole applicable corpus.
const MAX_RELEVANT = 3;
// Cap on the terms distilled from a failure — bounds the relevance scan so a
// huge error blob can never turn into an unbounded match loop.
const MAX_TERMS = 12;
// Terms shorter than this are dropped: too generic to make a match meaningful.
const MIN_TERM_LEN = 4;
// Cap on how much failure text is scanned for terms. A tool can dump a
// multi-megabyte stderr/stdout; the salient error words are always near the
// front, so we bound the input BEFORE lowercasing/splitting it — otherwise a
// giant blob would materialise a giant token array (a CPU/memory spike) even
// though the term COUNT is capped. Generous enough to never clip a real error.
const MAX_SCAN_CHARS = 4096;

// Read lessons narrow-to-broad through the store and resolve cross-scope
// precedence via the shared pure `resolvePrecedence` (the SAME first-seen /
// more-specific-wins merge `tree` renders) — so the hook and `tree` provably
// can't drift. Any per-scope failure is skipped (memory is best-effort).
export async function fetchLessons(store, cwd) {
  const scope = deriveScope(cwd);
  const groups = [];
  for (const s of scope.readOrder) {
    const res = await store.list({ scope: s, limit: 25 });
    if (!res || !res.ok) continue; // best-effort: a failed scope contributes nothing
    const entries = (Array.isArray(res.entries) ? res.entries : [])
      .filter((e) => e && e.key)
      .map((e) => ({ ...e, scope: s }));
    groups.push({ scope: s, error: null, entries });
  }
  // First value per key wins (most-specific scope, since `readOrder` is
  // narrow→broad) — exactly what the old inline `byKey` merge did, now via the
  // one shared resolver. The winners, in group order, are the injected set.
  const { groups: resolved } = resolvePrecedence({ groups });
  const lessons = [];
  for (const g of resolved) {
    for (const e of g.entries) if (e.winning) lessons.push(e);
  }
  return { scope, lessons: lessons.slice(0, MAX_LESSONS) };
}

// Render lessons as a compact markdown block, or null when there are none.
export function formatLessons(lessons, scope) {
  if (!lessons || lessons.length === 0) return null;
  const header =
    `LoreKit — ${lessons.length} shared ${lessons.length === 1 ? 'memory' : 'memories'} for ${scope.repoScope || 'this workspace'}. ` +
    `Treat as considerations, not rules; trust the current code if they conflict.`;
  const body = lessons
    .map((l) => {
      const first = String(l.value || '').split('\n')[0].slice(0, 300);
      return `- (${l.scope}) ${l.key}: ${first}`;
    })
    .join('\n');
  return `${header}\n${body}`;
}

// Distil a small set of significant, lowercased search TERMS from a tool
// failure — the tool name plus the salient words of its error text — used to
// look up lessons that might already cover this failure. Pure and total: any
// shape of `toolResponse` (object, string, null, malformed) is handled without
// throwing. Terms are de-duplicated, stopword- and length-filtered so a match
// stays meaningful, and the count is capped (`MAX_TERMS`) so a huge error blob
// can't blow up the downstream scan.
export function failureQuery(toolName, toolResponse) {
  const text = `${toolName ? String(toolName) : ''} ${errorText(toolResponse)}`.slice(0, MAX_SCAN_CHARS);
  const seen = new Set();
  const terms = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TERM_LEN || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

// Lessons whose key OR value literally contains ANY of the failure `terms`
// (case-insensitive, via the shared `matchesQuery` — never a regex), capped at
// `cap`. Pure and best-effort: no terms or no lessons → empty (the caller then
// falls back to the write-nudge alone). Preserves `lessons` order, so the
// most-specific scope's relevant lesson surfaces first.
export function relevantLessons(lessons, terms, cap = MAX_RELEVANT) {
  if (!Array.isArray(lessons) || !lessons.length || !Array.isArray(terms) || !terms.length) {
    return [];
  }
  const out = [];
  for (const l of lessons) {
    if (terms.some((t) => matchesQuery(l, t))) out.push(l);
    if (out.length >= cap) break;
  }
  return out;
}

// Render the relevant-lessons block injected alongside the failure nudge, or
// null when nothing matched. Framed as prior art, not a directive — same
// "considerations, not rules" stance as `formatLessons`.
export function formatRelevantLessons(lessons) {
  if (!lessons || lessons.length === 0) return null;
  const header =
    `LoreKit — you've hit something like this before. ${lessons.length} related ` +
    `${lessons.length === 1 ? 'memory' : 'memories'} (considerations, not rules; trust the current code if they conflict):`;
  const body = lessons
    .map((l) => {
      const first = String(l.value || '').split('\n')[0].slice(0, 300);
      return `- (${l.scope}) ${l.key}: ${first}`;
    })
    .join('\n');
  return `${header}\n${body}`;
}

// Build a tags hint string from config-resolved tags and scope defaults. Returns
// "" when there are no configured tags (no hint appended to the nudge).
function tagsHint(writeScope, { tagsDefault = [], scopeDefaults = null } = {}) {
  const tags = [...tagsDefault];
  if (scopeDefaults) {
    for (const [prefix, cfg] of Object.entries(scopeDefaults)) {
      if (
        writeScope === prefix ||
        writeScope.startsWith(prefix.endsWith('::') ? prefix : prefix + '::')
      ) {
        for (const t of Array.isArray(cfg.tags) ? cfg.tags : []) {
          if (typeof t === 'string' && t.length > 0 && !tags.includes(t)) tags.push(t);
        }
      }
    }
  }
  if (tags.length === 0) return '';
  return ` Include tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}].`;
}

// The retrospective nudge emitted at end-of-turn (one-shot per session).
// `control` is the resolved control object (optional) — carries tagsDefault and
// scopeDefaults when the repo/user config defines them.
export function retrospectiveNudge(scope, control) {
  const writeScope = scope.repoScope || 'global';
  const hint = tagsHint(writeScope, control);
  return (
    'LoreKit retrospective: if this session hit a stuck loop, a repeated ' +
    'command failure, a surprising gotcha, a near-miss, or a wrong assumption ' +
    'that cost time, record it now via the lorekit-memory skill ' +
    `(memory.write to ${writeScope}, phrased as an observation).${hint} ` +
    'If nothing was durable, do nothing.'
  );
}

// The nudge emitted when a tool failure is detected.
// `control` is the resolved control object (optional) — carries tagsDefault and
// scopeDefaults when the repo/user config defines them.
export function failureNudge(toolName, scope, control) {
  const writeScope = scope.repoScope || 'global';
  const hint = tagsHint(writeScope, control);
  const suffix = hint ? `${hint} So the next run avoids it.` : 'so the next run avoids it.';
  return (
    `LoreKit: the last ${toolName} call failed. If this is a recurring or ` +
    'non-obvious failure, consider recording the fix as a memory via ' +
    `lorekit-memory (memory.write to ${writeScope}) — ${suffix}`
  );
}

// Pull the human-readable error text out of a tool_response of any shape. Total:
// null/primitive/string/object all yield a (possibly empty) string, never a
// throw — the relevance lookup is best-effort and must not break the host.
function errorText(response) {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  if (typeof response !== 'object') return String(response);
  const parts = [];
  for (const f of TEXT_FIELDS) {
    const v = response[f];
    if (typeof v === 'string') parts.push(v);
    else if (v && typeof v === 'object') parts.push(safeStringify(v));
  }
  return parts.length ? parts.join(' ') : safeStringify(response);
}

function safeStringify(v) {
  try {
    return JSON.stringify(v) || '';
  } catch {
    return '';
  }
}

// The tool_response fields that commonly carry error text, across frameworks.
const TEXT_FIELDS = [
  'stderr',
  'error',
  'message',
  'stdout',
  'output',
  'content',
  'reason',
  'detail',
  'details',
];

// Generic words dropped from a failure query: too common to make a lesson match
// meaningful (they'd match almost anything). Kept small and hand-picked.
const STOPWORDS = new Set([
  'error',
  'errors',
  'failed',
  'failure',
  'tool',
  'call',
  'code',
  'exit',
  'with',
  'this',
  'that',
  'from',
  'null',
  'true',
  'false',
  'undefined',
  'command',
  'response',
  'status',
]);
