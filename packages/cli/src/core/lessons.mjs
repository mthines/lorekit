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
// The deep-link builder is the SAME pure module the `link` command and the
// `--link` flag use, so the hook's confirmation/nudge links are JSON-encoded
// correctly (a raw `?scope=global` silently means "all scopes") and can't drift
// from the command-line links.
import { loreScopeUrl, buildLessonUrl } from '../deeplink-pure.mjs';
// The SAME resolver `lorekit write` applies, so the TTL the nudge advises an
// agent to send is byte-for-byte the one the CLI would have applied itself. A
// hook cannot set a TTL — it only reads and emits text; the write happens later,
// over MCP, in the agent's context. Advising the number is the only lever the
// hook has, which is exactly why it must not be a second, hand-kept copy.
import { resolveDefaultTtlDays, matchesScopePrefix } from '../store/ttl.mjs';
import { FRICTION_FAILURE, FRICTION_STUCK_LOOP } from './friction.mjs';

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

// Cap on a lesson's one-line hook in the injected index. Long enough to jog
// recognition, short enough that N lessons stay a scannable list, not a wall —
// the full text is always one `memory.read` away.
const HOOK_LEN = 80;

// A lesson's first meaningful line, cleaned into a short recognisable hook:
// skips leading HTML-comment metadata (`<!-- ... -->`) and markdown heading
// marks, collapses whitespace, and truncates on a word boundary with an
// ellipsis — so nothing is ever cut mid-word into noise like "cascades to GE".
function lessonHook(value, max = HOOK_LEN) {
  let first = '';
  for (const raw of String(value || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('<!--')) continue; // skip blanks + meta comments
    first = line.replace(/^#+\s*/, '');              // strip markdown heading marks
    if (first) break;
  }
  first = first.replace(/\s+/g, ' ').trim();
  if (first.length <= max) return first;
  const clipped = first.slice(0, max);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

// Render the SessionStart block as a compact INDEX — one terse line per lesson
// (scope, key, and a short hook), never the full bodies. This mirrors the
// lorekit-memory intake rule ("report briefly") and the MEMORY.md index pattern:
// surface WHAT is known so the agent can `memory.read` the one lesson that turns
// out to matter, instead of paying for every body up front. Null when empty.
// `instruction` — an optional extra line appended after the index, sourced from
// `hooks.instructions.SessionStart` in the control config. Lets teams inject
// project-specific guidance (e.g. "focus on migration safety") without touching
// the hook internals. Visible even when there are no lessons.
export function formatLessons(lessons, scope, { instruction = null } = {}) {
  const noun = lessons && lessons.length === 1 ? 'memory' : 'memories';
  if (!lessons || lessons.length === 0) {
    // No lessons — only emit if there is a custom instruction to show.
    if (!instruction) return null;
    return (
      `LoreKit: 0 ${noun} loaded · ${scope.repoScope || 'this workspace'} ` +
      `— considerations, not rules; read any in full with memory.read.\n\n` +
      `Project instruction: ${instruction}`
    );
  }
  const header =
    `LoreKit: ${lessons.length} ${noun} loaded · ${scope.repoScope || 'this workspace'} ` +
    `— considerations, not rules; read any in full with memory.read.`;
  const body = lessons.map((l) => `- (${l.scope}) ${l.key} — ${lessonHook(l.value)}`).join('\n');
  const instructionBlock = instruction ? `\n\nProject instruction: ${instruction}` : '';
  return `${header}\n${body}${instructionBlock}`;
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
// null when nothing matched. Same compact-index shape as `formatLessons`, with a
// touch more hook per line (there are at most MAX_RELEVANT and they're directly
// actionable). Framed as prior art, not a directive.
export function formatRelevantLessons(lessons) {
  if (!lessons || lessons.length === 0) return null;
  const noun = lessons.length === 1 ? 'memory' : 'memories';
  const header =
    `LoreKit: ${lessons.length} related ${noun} — you've hit something like this before ` +
    `(considerations, not rules; read in full with memory.read):`;
  const body = lessons.map((l) => `- (${l.scope}) ${l.key} — ${lessonHook(l.value, 140)}`).join('\n');
  return `${header}\n${body}`;
}

// Build a tags hint string from config-resolved tags and scope defaults. Returns
// "" when there are no configured tags (no hint appended to the nudge).
function tagsHint(writeScope, control) {
  const { tagsDefault = [], scopeDefaults = null } = control || {};
  const tags = [...tagsDefault];
  if (scopeDefaults) {
    for (const [prefix, cfg] of Object.entries(scopeDefaults)) {
      // Tags UNION across every matching prefix — they accumulate, so a broad
      // and a narrow entry both contribute. The TTL hint below deliberately does
      // NOT: a memory has one expiry, so the most specific prefix wins outright.
      if (matchesScopePrefix(writeScope, prefix)) {
        for (const t of Array.isArray(cfg.tags) ? cfg.tags : []) {
          if (typeof t === 'string' && t.length > 0 && !tags.includes(t)) tags.push(t);
        }
      }
    }
  }
  if (tags.length === 0) return '';
  return ` Include tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}].`;
}

// Build the TTL hint appended to a nudge. Empty string when the scope has no
// configured default, so an unconfigured repo's nudge is unchanged.
//
// Phrased as an instruction to pass `ttl_days` rather than as a statement about
// what will happen, because nothing enforces it: the agent is about to call
// `memory.write` over MCP, where omitting `ttl_days` still means permanent. The
// hint is advice with a number attached — the same posture as the tags hint.
function ttlHint(writeScope, control) {
  const days = resolveDefaultTtlDays(writeScope, control || {});
  if (days == null) return '';
  return ` Set ttl_days: ${days} (this scope's configured default) unless the lesson is durable enough to keep forever.`;
}

// One-line phrases for the detected friction reason codes (see core/friction.mjs),
// so the nudge names what happened instead of a generic prompt.
const REASON_PHRASES = {
  [FRICTION_FAILURE]: 'a failed tool call',
  [FRICTION_STUCK_LOOP]: 'a repeated retry',
};

// Join detected reason codes into a readable clause ("a failed tool call and a
// repeated retry"). Empty/unknown reasons → "" (caller uses the generic prompt).
function describeReasons(reasons) {
  const phrases = (Array.isArray(reasons) ? reasons : [])
    .map((r) => REASON_PHRASES[r])
    .filter(Boolean);
  if (phrases.length === 0) return '';
  if (phrases.length === 1) return phrases[0];
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
}

// The retrospective nudge emitted at end-of-turn (one-shot per session).
// `control` is the resolved control object (optional) — carries tagsDefault and
// scopeDefaults when the repo/user config defines them. `opts.reasons` is the
// detected friction reason codes (from core/friction.mjs) when `hooks.stop` is
// `friction`; when present the nudge names them so the reflection is grounded.
// Kept to a single line — the lore deep-link lives on the write CONFIRMATION,
// which is where a link is actually actionable.
export function retrospectiveNudge(scope, control, { reasons = [] } = {}) {
  const writeScope = scope.repoScope || 'global';
  const hint = `${tagsHint(writeScope, control)}${ttlHint(writeScope, control)}`;
  const instruction = control && control.hooksInstructions && control.hooksInstructions.Stop
    ? `\n\nProject instruction: ${control.hooksInstructions.Stop}` : '';
  const detected = describeReasons(reasons);
  const lead = detected
    ? `LoreKit: this session hit ${detected} — a lesson worth saving?`
    : `LoreKit: any friction worth remembering (stuck loop, repeat failure, gotcha, wrong assumption)?`;
  return `${lead} memory.write to ${writeScope}; else skip.${hint}${instruction}`;
}

// Terse confirmation emitted via PostToolUse when a memory.write succeeded.
// `key` is the lesson key from the tool input (may be null when it isn't
// surfaced). `writtenScope` is the ACTUAL scope the write targeted (from the tool
// input) — the link must point there, not at `repoScope`: a `global` (or project)
// write deep-linked to `repoScope` would open a lesson ref that doesn't exist.
// Falls back to the cwd's repo scope, then `global`, when the write scope is
// unknown. When the key is known the link opens that exact lesson's detail sheet
// (`?scope=…&lesson=…`); otherwise it filters the Explorer to the write scope —
// both JSON-encoded via the shared builder so they actually open the intended view.
export function writeConfirmation(scope, key, writtenScope) {
  const target =
    typeof writtenScope === 'string' && writtenScope ? writtenScope : scope.repoScope || 'global';
  const keyPart = key ? ` · ${key}` : '';
  const url = key ? buildLessonUrl(target, key) : loreScopeUrl(target);
  return `LoreKit: memory saved to ${target}${keyPart}\nView: ${url}`;
}

// The nudge emitted when a tool failure is detected.
// `control` is the resolved control object (optional) — carries tagsDefault and
// scopeDefaults when the repo/user config defines them.
export function failureNudge(toolName, scope, control) {
  const writeScope = scope.repoScope || 'global';
  const hint = `${tagsHint(writeScope, control)}${ttlHint(writeScope, control)}`;
  const instruction = control && control.hooksInstructions && control.hooksInstructions.PostToolUseFailure
    ? `\n\nProject instruction: ${control.hooksInstructions.PostToolUseFailure}` : '';
  return (
    `LoreKit: the last ${toolName} call failed. If it's recurring or non-obvious, ` +
    `memory.write to ${writeScope} with the fix so the next run avoids it.${hint}${instruction}`
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
