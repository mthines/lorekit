// TypeSafe (Jev) judgment — the pure half (CLI twin).
//
// Zero-import `.mjs` behavioural twin of `packages/mcp-core/src/judgment/judgment.ts`
// (and its verbatim edge mirror `supabase/functions/_shared/judgment/judgment.ts`).
// `judgment-parity.spec.ts` loads this file with `import(\`file://${path}\`)` and
// asserts deep-equal results over shared fixtures for every export below — the
// `lesson-rank.ts` ↔ `lessons-pure.mjs` pattern applied to a second cross-language
// pair. Keep this in step with `judgment.ts`: change a rule here, change it
// there, and the parity spec will say so.
//
// Zero-dependency by the same rule as every other `*-pure.mjs` in this
// directory (`packages/cli/test/source-hygiene.test.mjs` enforces it) — the
// CLI ships with no build step, so nothing here may `import` anything at all.

/** @type {string} */
export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** @type {string} */
export const TYPESAFE_MODELS_ENDPOINT = 'https://api.typesafe.ai/v1/models';

/** @type {string} */
export const TYPESAFE_MODEL = 'jev-latest';

/** @type {string} */
export const JUDGMENT_PROVIDER = 'typesafe';

/** @type {number} */
export const JUDGMENT_TOP_N = 25;

/** @type {number} */
export const JUDGMENT_TIMEOUT_MS = 1500;

/** @type {number} */
export const MAX_LESSON_CHARS = 1200;

/** @type {number} */
export const MAX_SITUATION_CHARS = 2000;

/** @type {number} */
export const UNJUDGED_RELEVANCE = 0.5;

/** @type {readonly string[]} */
export const RELEVANCE_LEVELS = Object.freeze([
  'unrelated to this situation',
  'related topic, but would not change what the agent should do here',
  'directly applies — would change or inform what the agent should do in this situation',
]);

/** @type {Readonly<Record<string, Readonly<{ called: boolean }>>>} */
export const JUDGMENT_OUTCOMES = Object.freeze({
  applied: Object.freeze({ called: true }),
  timeout: Object.freeze({ called: true }),
  rejected: Object.freeze({ called: true }),
  rate_limited: Object.freeze({ called: true }),
  error: Object.freeze({ called: true }),
  malformed: Object.freeze({ called: true }),
  skipped_no_key: Object.freeze({ called: false }),
  skipped_key_unavailable: Object.freeze({ called: false }),
  skipped_disabled: Object.freeze({ called: false }),
  skipped_no_query: Object.freeze({ called: false }),
  skipped_no_candidates: Object.freeze({ called: false }),
});

/**
 * @param {{ apiKey: unknown, env?: Record<string, string | undefined> }} i
 * @returns {{ enabled: true, apiKey: string } | { enabled: false, reason: 'skipped_no_key' | 'skipped_disabled' }}
 */
export function resolveJudgmentConfig(i) {
  const env = i.env ?? {};
  const disabledRaw = String(env['LOREKIT_JUDGMENT_DISABLED'] ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(disabledRaw)) return { enabled: false, reason: 'skipped_disabled' };
  const apiKey = typeof i.apiKey === 'string' ? i.apiKey.trim() : '';
  if (!apiKey) return { enabled: false, reason: 'skipped_no_key' };
  return { enabled: true, apiKey };
}

/**
 * @param {{ org_id?: unknown, org?: unknown }} row
 * @returns {boolean}
 */
export function isJudgmentEligible(row) {
  const hasOrgId = row.org_id !== null && row.org_id !== undefined;
  const hasOrg = row.org !== null && row.org !== undefined;
  return !hasOrgId && !hasOrg;
}

/**
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
function truncateWordBoundary(text, max) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * @param {string} situation
 * @param {readonly { ref: string, key: string, value: string, trigger?: string | null }[]} lessons
 * @returns {{ body: Record<string, unknown>, questionIds: string[] }}
 */
export function buildJudgmentRequest(situation, lessons) {
  const capped = lessons.slice(0, JUDGMENT_TOP_N);
  const state = { situation: truncateWordBoundary(situation, MAX_SITUATION_CHARS) };
  const questionIds = [];
  const questions = {};
  capped.forEach((lesson, i) => {
    const id = `c${i}`;
    questionIds.push(id);
    questions[id] = {
      type: 'score',
      criteria: RELEVANCE_LEVELS,
      instructions: {
        lesson: {
          key: lesson.key,
          trigger: lesson.trigger ?? null,
          body: truncateWordBoundary(lesson.value, MAX_LESSON_CHARS),
        },
        question: 'How useful is `lesson` to an agent in the situation described by the state?',
      },
    };
  });
  return { body: { state, model: TYPESAFE_MODEL, questions }, questionIds };
}

/**
 * @param {number} n
 * @returns {number}
 */
function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

/**
 * @param {unknown} json
 * @param {readonly { ref: string, key: string, value: string, trigger?: string | null }[]} lessons
 * @returns {{ ok: true, relevance: Map<string, number>, model: string | null, inputTokens: number | null } | { ok: false, outcome: 'malformed' }}
 */
export function parseJudgmentResponse(json, lessons) {
  if (json === null || typeof json !== 'object') return { ok: false, outcome: 'malformed' };
  const answers = json['answers'];
  if (answers === null || typeof answers !== 'object') return { ok: false, outcome: 'malformed' };
  const levels = RELEVANCE_LEVELS.length;
  const capped = lessons.slice(0, JUDGMENT_TOP_N);
  const relevance = new Map();
  for (let i = 0; i < capped.length; i++) {
    const answer = answers[`c${i}`];
    if (answer === null || typeof answer !== 'object') return { ok: false, outcome: 'malformed' };
    if (answer['type'] !== 'score') return { ok: false, outcome: 'malformed' };
    const score = answer['score'];
    if (typeof score !== 'number' || !Number.isFinite(score)) return { ok: false, outcome: 'malformed' };
    relevance.set(capped[i].ref, clamp01(score / (levels - 1)));
  }
  const model = typeof json['model'] === 'string' ? json['model'] : null;
  const usage = json['usage'];
  const inputTokens =
    usage !== null && typeof usage === 'object' && typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : null;
  return { ok: true, relevance, model, inputTokens };
}

/**
 * @param {number} status
 * @returns {'rejected' | 'rate_limited' | 'error'}
 */
export function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return 'rejected';
  if (status === 429 || status === 529) return 'rate_limited';
  return 'error';
}

/**
 * @param {unknown} err
 * @returns {'timeout' | 'error'}
 */
export function classifyThrown(err) {
  const name = err !== null && typeof err === 'object' && 'name' in err ? String(err.name) : '';
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error';
}

/**
 * @template {{ relevance?: number | null }} T
 * @param {readonly T[]} candidates
 * @param {Map<string, number> | null} judged
 * @param {(c: T) => string} refOf
 * @returns {T[]}
 */
export function withJudgedRelevance(candidates, judged, refOf) {
  if (judged === null) return candidates;
  return candidates.map((c) => {
    const ref = refOf(c);
    const relevance = judged.has(ref) ? judged.get(ref) : UNJUDGED_RELEVANCE;
    return { ...c, relevance };
  });
}
