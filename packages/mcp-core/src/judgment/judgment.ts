/**
 * TypeSafe (Jev) judgment — the pure half.
 *
 * Bring-your-own-key relevance grading for `GET /memories/relevant` and the
 * CLI failure hook. Everything here is a total function over plain data: how
 * a request is shaped, how a response maps to relevance, how a failure is
 * classified, how judged relevance recombines with the baseline candidate
 * list. The impure half — the actual `fetch`, the key, the clock — lives in
 * `supabase/functions/_shared/judgment/judgment-client.ts` and in
 * `packages/cli/src/core/judgment.mjs`, the two places that can reach a
 * network. This file is import-free so it can be mirrored verbatim into
 * `supabase/functions/_shared/judgment/judgment.ts`
 * (`edge-parity.spec.ts` MIRRORS), and it has a second, cross-LANGUAGE twin —
 * `packages/cli/src/shared/judgment-pure.mjs` — held to behavioural parity by
 * `judgment-parity.spec.ts` (the `lesson-rank.ts` pattern).
 *
 * WHY A THIRD PROVIDER SPLIT, following `embedding.ts`: this is the second
 * code path in the repo that spends a caller's money per call, and the first
 * that spends someone else's money on their own third-party account rather
 * than LoreKit's. `resolveJudgmentConfig` is deliberately the mirror of
 * `resolveEmbeddingConfig` — a key alone must not silently start billing
 * (there is no LoreKit-side flag here because BYOK IS the opt-in: see D13),
 * and the operator kill switch `LOREKIT_JUDGMENT_DISABLED` is the one lever
 * ops has if TypeSafe degrades in a way `malformed`/`rate_limited` fallback
 * does not fully absorb.
 *
 * See `docs/judgment.md` for the endpoint contract this was verified against
 * (2026-09-22, live docs.typesafe.ai) and `docs/decisions.md`'s "Judgment is
 * BYOK, best-effort, never on the correctness path" for the posture every
 * function below encodes: ANY failure here must reproduce today's exact
 * baseline output (R8/R15), never degrade it and never throw.
 */

/** The TypeSafe Jev endpoint this module's wire format targets. Referenced
 *  nowhere else in either runtime — see AC-9: the literal lives only in the
 *  pure modules, the `fetch(` of it only in the one shell per runtime. */
export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** A cheap authenticated GET, usable as a key-validity probe (`lorekit doctor`
 *  and `probeTypeSafeKey`). Never called from the rerank path itself. */
export const TYPESAFE_MODELS_ENDPOINT = 'https://api.typesafe.ai/v1/models';

/** The rolling alias TypeSafe documents as always resolving to their current
 *  Jev release. Recorded as a span attribute (`lorekit.judgment.provider`
 *  carries the provider, not the model); the response's own `model` field is
 *  what's actually reported, so an alias move is visible without a code change. */
export const TYPESAFE_MODEL = 'jev-latest';

/** The provider id stored on the key row and reported in telemetry. The
 *  schema's `provider` literal (`domain/judgment.ts`) is the single other
 *  place this string is spelled out — kept as a separate constant here rather
 *  than imported, because this module takes no imports at all. */
export const JUDGMENT_PROVIDER = 'typesafe';

/**
 * How many shortlisted candidates go into the one batched request.
 *
 * D7's cost/latency cap. 25 covers the route's default `limit` of 10 with
 * headroom for `min_score` filtering and diversification to still have
 * choices, while keeping the worst case (25 × ~1.6k chars ≈ 10k tokens) well
 * inside Jev's 64k per-request budget at about $0.0004. `buildJudgmentRequest`
 * enforces this as a hard slice, not just a caller convention, so the cap
 * holds even if a caller passes a longer shortlist by mistake.
 */
export const JUDGMENT_TOP_N = 25;

/**
 * The one per-request timeout, enforced by the impure shell via
 * `AbortSignal.timeout(JUDGMENT_TIMEOUT_MS)`. No retries (D7): retrying a
 * 429/529 would risk exceeding this bound, which breaks R8's "never slows
 * beyond the timeout because of Jev".
 */
export const JUDGMENT_TIMEOUT_MS = 1500;

/** Cap on characters per lesson body sent to TypeSafe, on a word boundary —
 *  the same shape as `embeddingInput`'s truncation. Bounds one oversized
 *  lesson (the schema allows a 64 KB `value`) from blowing the per-request
 *  token budget on its own. */
export const MAX_LESSON_CHARS = 1200;

/** Cap on characters for the `state.situation` text (the query / hook
 *  context), truncated the same way. */
export const MAX_SITUATION_CHARS = 2000;

/**
 * The relevance assigned to a candidate the judge never saw: outside the
 * top-`JUDGMENT_TOP_N` shortlist, or excluded as org-owned (D9). Same
 * "unknown = neutral prior" idiom as `COLD_START_OUTCOME_PRIOR` in
 * `lesson-rank.ts` — a row judgment skipped must neither be favoured nor
 * punished relative to a row it graded low.
 */
export const UNJUDGED_RELEVANCE = 0.5;

/**
 * The 3-level Score criteria (D6), index i meaning "level i out of
 * `RELEVANCE_LEVELS.length - 1`". `score / (levels - 1)` is exactly TypeSafe's
 * own normalisation (see `api.md`), so `parseJudgmentResponse` need not
 * reimplement it independently of what these strings promise.
 */
export const RELEVANCE_LEVELS = [
  'unrelated to this situation',
  'related topic, but would not change what the agent should do here',
  'directly applies — would change or inform what the agent should do in this situation',
] as const;

/**
 * The closed outcome vocabulary (D14), as ONE `as const` record rather than
 * parallel maps — a single source of truth for which outcomes represent an
 * actual TypeSafe call (`called: true`, and therefore a billable/countable
 * event worth `recordJudgmentCall`) versus a call that never went out.
 * `JudgmentOutcome` is derived from this record's keys, so the type and the
 * metadata can never drift apart.
 */
export const JUDGMENT_OUTCOMES = {
  /** A request went out and produced usable scores; the reranked order is used. */
  applied: { called: true },
  /** `AbortSignal.timeout` fired before a response arrived. */
  timeout: { called: true },
  /** 401/403 — the key was rejected. `_record_call` may flip the key's status. */
  rejected: { called: true },
  /** 429/529 — rate limited or overloaded. No retry. */
  rate_limited: { called: true },
  /** Any other non-2xx status. */
  error: { called: true },
  /** 200, but the body did not parse into a usable answer for every
   *  shortlisted question (all-or-nothing — see `parseJudgmentResponse`). */
  malformed: { called: true },
  /** No caller-supplied key and no stored key resolved (or a service-role
   *  caller with no `userId` to look one up for). */
  skipped_no_key: { called: false },
  /** The key lookup itself failed (RPC error, Vault relations absent). Fails
   *  closed to the baseline path (D5) — never surfaced as an error response. */
  skipped_key_unavailable: { called: false },
  /** `LOREKIT_JUDGMENT_DISABLED` is set (D13). */
  skipped_disabled: { called: false },
  /** No `q` on the request — nothing to judge relevance against. */
  skipped_no_query: { called: false },
  /** Every candidate was org-owned or fell below `min_score` — no eligible
   *  shortlist survived to send. */
  skipped_no_candidates: { called: false },
} as const;

/** The closed outcome union, derived from `JUDGMENT_OUTCOMES` rather than
 *  hand-duplicated (see the record's own doc comment). */
export type JudgmentOutcome = keyof typeof JUDGMENT_OUTCOMES;

/** One candidate as `buildJudgmentRequest`/`withJudgedRelevance` see it.
 *  `ref` is caller-defined and opaque here — the edge handler uses
 *  `scope:key`, the CLI hook uses whatever `refOf` it passes — it only needs
 *  to be unique within one call's candidate set, because it is the join key
 *  between the response's per-question answers and the original rows. */
export interface JudgedLessonInput {
  ref: string;
  key: string;
  value: string;
  trigger?: string | null;
}

/**
 * Resolve whether judgment runs at all, from a caller-supplied key and an
 * environment bag — total, never throws, read on the request path in both
 * runtimes.
 *
 * The kill switch is checked BEFORE the key: an operator who has decided Jev
 * is unhealthy should not need to also know whether any particular caller has
 * a key configured. Order matters for the returned reason, not for the
 * boolean: either non-key reason means "no request went out" identically.
 */
export function resolveJudgmentConfig(i: {
  apiKey: unknown;
  env?: Record<string, string | undefined>;
}): { enabled: true; apiKey: string } | { enabled: false; reason: 'skipped_no_key' | 'skipped_disabled' } {
  const env = i.env ?? {};
  const disabledRaw = String(env['LOREKIT_JUDGMENT_DISABLED'] ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(disabledRaw)) return { enabled: false, reason: 'skipped_disabled' };
  const apiKey = typeof i.apiKey === 'string' ? i.apiKey.trim() : '';
  if (!apiKey) return { enabled: false, reason: 'skipped_no_key' };
  return { enabled: true, apiKey };
}

/**
 * Personal-lore-only eligibility gate (D9). A row carrying either shape of
 * org ownership — the edge candidate's `org_id` column, or the CLI hook's
 * `org`/`org_id` hit field — is excluded from judgment for PR 1: a member's
 * own key is not the org's consent to send org-owned lore to a third party.
 * Callers filter their shortlist with this BEFORE calling
 * `buildJudgmentRequest`; excluded rows never reach it (AC-27) and get
 * `UNJUDGED_RELEVANCE` from `withJudgedRelevance` instead.
 */
export function isJudgmentEligible(row: { org_id?: unknown; org?: unknown }): boolean {
  const hasOrgId = row.org_id !== null && row.org_id !== undefined;
  const hasOrg = row.org !== null && row.org !== undefined;
  return !hasOrgId && !hasOrg;
}

/** Word-boundary truncation, the same shape as `embeddingInput`'s. */
function truncateWordBoundary(text: unknown, max: number): string {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * Build the ONE batched Jev request body for a shortlist (D6/D7). Every
 * question shares the same `state.situation` and is evaluated independently
 * — TypeSafe never sees the question id, so `c0..c{n-1}` is purely this
 * module's own join key, not anything sent semantically.
 *
 * Hard-slices to `JUDGMENT_TOP_N` regardless of how many lessons the caller
 * passes, so the cap is a property of this function rather than a convention
 * every caller must separately uphold (AC-10's "requests carry ≤25 score
 * questions").
 */
export function buildJudgmentRequest(
  situation: string,
  lessons: readonly JudgedLessonInput[],
): { body: Record<string, unknown>; questionIds: string[] } {
  const capped = lessons.slice(0, JUDGMENT_TOP_N);
  const state = { situation: truncateWordBoundary(situation, MAX_SITUATION_CHARS) };
  const questionIds: string[] = [];
  const questions: Record<string, unknown> = {};
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

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Parse a 200 response into a `ref → relevance` map, or fail closed to
 * `malformed`. ALL-OR-NOTHING (D14): one shortlisted question missing, of the
 * wrong `type`, or carrying a non-finite `score` fails the whole response —
 * never a partial map, which would silently mix judged and unjudged rows
 * inside what should be one coherent shortlist decision.
 *
 * `lessons` here must be the SAME slice (and order) passed to
 * `buildJudgmentRequest`, so `c{i}` maps back to `lessons[i].ref`.
 */
export function parseJudgmentResponse(
  json: unknown,
  lessons: readonly JudgedLessonInput[],
): { ok: true; relevance: Map<string, number>; model: string | null; inputTokens: number | null } | { ok: false; outcome: 'malformed' } {
  if (json === null || typeof json !== 'object') return { ok: false, outcome: 'malformed' };
  const obj = json as Record<string, unknown>;
  const answers = obj['answers'];
  if (answers === null || typeof answers !== 'object') return { ok: false, outcome: 'malformed' };
  const answersObj = answers as Record<string, unknown>;
  const levels = RELEVANCE_LEVELS.length;
  const capped = lessons.slice(0, JUDGMENT_TOP_N);
  const relevance = new Map<string, number>();
  for (let i = 0; i < capped.length; i++) {
    const answer = answersObj[`c${i}`];
    if (answer === null || typeof answer !== 'object') return { ok: false, outcome: 'malformed' };
    const a = answer as Record<string, unknown>;
    if (a['type'] !== 'score') return { ok: false, outcome: 'malformed' };
    const score = a['score'];
    if (typeof score !== 'number' || !Number.isFinite(score)) return { ok: false, outcome: 'malformed' };
    relevance.set(capped[i].ref, clamp01(score / (levels - 1)));
  }
  const model = typeof obj['model'] === 'string' ? obj['model'] : null;
  const usage = obj['usage'];
  const inputTokens =
    usage !== null && typeof usage === 'object' && typeof (usage as Record<string, unknown>)['input_tokens'] === 'number'
      ? ((usage as Record<string, unknown>)['input_tokens'] as number)
      : null;
  return { ok: true, relevance, model, inputTokens };
}

/** Maps a non-2xx status to an outcome (D14). 401/403 is the key itself being
 *  rejected — distinct from 429/529 (load-shedding) and every other status
 *  (a generic `error`, e.g. a 422 validation failure this module's own
 *  request-building should never provoke, or a 5xx that is not 529). */
export function classifyHttpStatus(status: number): 'rejected' | 'rate_limited' | 'error' {
  if (status === 401 || status === 403) return 'rejected';
  if (status === 429 || status === 529) return 'rate_limited';
  return 'error';
}

/** Maps a thrown value from the impure shell's `fetch` to an outcome (D14).
 *  `AbortSignal.timeout` rejects with a `TimeoutError`; some runtimes surface
 *  the older `AbortError` name for the same condition — either means the
 *  budget in `JUDGMENT_TIMEOUT_MS` was exceeded, not a wire-level error. */
export function classifyThrown(err: unknown): 'timeout' | 'error' {
  const name = err !== null && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name) : '';
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error';
}

/**
 * Recombine judged relevance with the full candidate population (D8 step 3).
 *
 * `judged === null` (every non-`applied` outcome) returns the SAME array —
 * true identity, not a deep-equal copy — so a keyless or failed-judgment
 * request runs the byte-identical baseline path all the way through
 * `rankLessons`/`selectDiverse` (R8/R15; AC-12 asserts this literally, not
 * just structurally).
 *
 * Otherwise every candidate gets a NEW object: the judged value when
 * `refOf(c)` is in the map, `UNJUDGED_RELEVANCE` when it is not (out of the
 * top-N shortlist, or excluded as org-owned). Every other field is spread
 * through unchanged.
 */
export function withJudgedRelevance<T extends { relevance?: number | null }>(
  candidates: readonly T[],
  judged: Map<string, number> | null,
  refOf: (c: T) => string,
): T[] {
  if (judged === null) return candidates as T[];
  return candidates.map((c) => {
    const ref = refOf(c);
    const relevance = judged.has(ref) ? (judged.get(ref) as number) : UNJUDGED_RELEVANCE;
    return { ...c, relevance };
  });
}
