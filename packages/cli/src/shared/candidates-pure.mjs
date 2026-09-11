// Pure core for `lorekit invariants candidates` — ranks near-duplicate
// clusters (the same Jaccard heuristic `dedupe` uses) as merge candidates for
// a hand-written compile-pipeline invariant declaration.
//
// This module is deliberately read-only in a stronger sense than "no writes":
// it never CLASSIFIES anything. It surfaces what a lesson already states about
// itself (a parsed meta comment, a seen_count, a resolved recurrence class)
// and ranks it — it does not decide whether a trigger-context is mechanically
// detectable, and it does not validate `status` against a fixed vocabulary
// (none is defined anywhere in this codebase yet). That judgment is the human
// step the compile pipeline's "never auto-compile, never auto-gate" rule
// protects; a scan that started making those calls would be the thing the
// rule exists to prevent.
//
// Operates on already-enriched cluster members — `{ scope, key, seenCount,
// value }` — leaving the store I/O and the seen_count/meta correlation to the
// command (`../commands/invariants.mjs`). Zero-dep, total: malformed input
// degrades to the empty/default case rather than throwing.

const META_COMMENT_RE = /<!--\s*meta:([\s\S]*?)-->/;
const META_FIELD_RE = /([\w-]+)=("(?:[^"\\]|\\.)*"|\S+)/g;

/**
 * Extract the `<!-- meta: seen_count=1 status=active expires=<iso>
 * trigger-context="<signal>" -->` convention documented in the lorekit-setup
 * skill's `self-improvement-loops.md`. Nothing in the CLI parses this
 * convention today; this is read-only extraction for a human's judgment, not
 * a schema the scan enforces. Absent or malformed input yields `{}`, never a
 * throw — a lesson written before (or without) the convention is not an
 * error, just a candidate with no meta fields.
 */
export function parseMetaComment(value) {
  if (typeof value !== 'string') return {};
  const m = META_COMMENT_RE.exec(value);
  if (!m) return {};
  const out = {};
  META_FIELD_RE.lastIndex = 0;
  let mm;
  while ((mm = META_FIELD_RE.exec(m[1]))) {
    const [, k, rawV] = mm;
    out[k] =
      rawV.startsWith('"') && rawV.endsWith('"') ? rawV.slice(1, -1).replace(/\\"/g, '"') : rawV;
  }
  return out;
}

const STATUS_TAG_PREFIX = 'status::';

/**
 * A member's declared status. The canonical home is a `status::<value>` tag —
 * first-class, filterable, and visible to a human reading the lesson — which is
 * what the lorekit-setup skill now prescribes. A legacy `<!-- meta: status=… -->`
 * comment in the body is still honoured so lessons written under the older
 * convention keep their signal; the tag wins when both are present. Returns `''`
 * when neither declares one.
 */
export function statusOf(member) {
  const tags = Array.isArray(member?.tags) ? member.tags : [];
  for (const t of tags) {
    if (typeof t === 'string' && t.startsWith(STATUS_TAG_PREFIX)) {
      const v = t.slice(STATUS_TAG_PREFIX.length).trim();
      if (v) return v;
    }
  }
  const fromMeta = parseMetaComment(member?.value).status;
  return typeof fromMeta === 'string' ? fromMeta.trim() : '';
}

const APPLIES_WHEN_RE = /^\s*\*\*Applies when:\*\*\s*(.+?)\s*$/im;

/**
 * A member's applicability signal, printed verbatim and never interpreted. The
 * canonical home is the visible `**Applies when:**` line the lorekit-setup
 * skill prescribes; a legacy `trigger-context` meta field is the fallback.
 * Returns `''` when the lesson declares neither.
 */
export function appliesWhenOf(member) {
  const value = member?.value;
  if (typeof value === 'string') {
    const m = APPLIES_WHEN_RE.exec(value);
    if (m && m[1]) return m[1].trim();
  }
  const fromMeta = parseMetaComment(value)['trigger-context'];
  return typeof fromMeta === 'string' ? fromMeta.trim() : '';
}

function totalSeen(members) {
  return (members || []).reduce((n, m) => n + (Number.isFinite(m.seenCount) ? m.seenCount : 0), 0);
}

function distinctScopeCount(members) {
  return new Set((members || []).map((m) => m.scope)).size;
}

/**
 * A cluster is a candidate when its recurrence signal is real: either the
 * summed `seenCount` across members crosses `minSeenCount` (default 3 — the
 * kickoff's "seen_count >= 3" criterion, applied to the SUM across the
 * cluster's members rather than any single one, since the whole pitch of a
 * candidate is "these N sightings are really one entry"), or a member already
 * declares a non-"active" status (a `status::<value>` tag, or a legacy meta
 * comment — see `statusOf`).
 */
export function isCandidate(members, { minSeenCount = 3 } = {}) {
  if (totalSeen(members) >= minSeenCount) return true;
  return (members || []).some((m) => {
    const status = statusOf(m);
    return status.length > 0 && status !== 'active';
  });
}

/** Recurrence × distinct scopes — the ranking signal the kickoff names. */
export function scoreCandidate(members) {
  return totalSeen(members) * distinctScopeCount(members);
}

/**
 * Filter a set of dedupe-style clusters down to candidates and rank them,
 * highest score first (ties broken by member count, then the first member's
 * `scope::key` for determinism). Each input cluster is
 * `{ members: [{scope,key,seenCount,value}], size, minSimilarity?,
 * maxSimilarity? }`. Never mutates the input.
 *
 * `resolveClass`, when supplied, is called with the cluster's raw members to
 * attach a resolved recurrence class (the `dedupe` join, reused here) — a
 * candidate already resolving to a known class is a stronger case ("this
 * should join an existing invariant") than one that doesn't ("this might be a
 * new class"). Optional so the pure ranking logic stays testable without it.
 */
export function rankCandidates(clusters, { minSeenCount = 3, resolveClass } = {}) {
  return (clusters || [])
    .filter((cl) => isCandidate(cl.members, { minSeenCount }))
    .map((cl) => {
      const members = (cl.members || []).map((m) => ({
        ...m,
        meta: parseMetaComment(m.value),
        status: statusOf(m),
        appliesWhen: appliesWhenOf(m),
      }));
      return {
        members,
        size: cl.size ?? members.length,
        minSimilarity: cl.minSimilarity,
        maxSimilarity: cl.maxSimilarity,
        recurrenceClass: typeof resolveClass === 'function' ? resolveClass(cl.members) : null,
        score: scoreCandidate(cl.members),
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.size !== a.size) return b.size - a.size;
      const aKey = `${a.members[0]?.scope}::${a.members[0]?.key}`;
      const bKey = `${b.members[0]?.scope}::${b.members[0]?.key}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
}
