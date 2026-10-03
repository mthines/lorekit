/**
 * TypeSafe (Jev) judgment — the impure fetch shell (edge runtime).
 *
 * The ONE place on the edge that actually calls out to TypeSafe
 * (`fetch(TYPESAFE_ENDPOINT` — AC-9: the literal endpoint lives only in the
 * pure modules, the fetch of it only here and in the CLI's
 * `packages/cli/src/core/judgment.mjs`). Every decision about WHETHER to call,
 * WHAT to send, and HOW to read the answer is delegated to the pure
 * `judgment.ts` — this file only owns the network round trip, the timeout, the
 * span, and recording the outcome against the key's row.
 *
 * `judgeCandidates` is deliberately the ONLY exported entry point
 * (`supabase/functions/memories/handlers/relevant.ts` calls it exactly once —
 * AC-11): resolving config, building the request, classifying the response,
 * and recording the call all happen inside so no caller can accidentally skip
 * one of them.
 */
import { SPAN_KIND_CLIENT, type Span } from '../telemetry/otel.ts';
import { recordJudgmentKeyCall } from './judgment-keys.ts';
import {
  TYPESAFE_ENDPOINT,
  JUDGMENT_TIMEOUT_MS,
  JUDGMENT_PROVIDER,
  resolveJudgmentConfig,
  isJudgmentEligible,
  buildJudgmentRequest,
  parseJudgmentResponse,
  classifyHttpStatus,
  classifyThrown,
  type JudgedLessonInput,
  type JudgmentOutcome,
} from './judgment.ts';

/** One row `relevant.ts` is deciding whether to send to the judge. Carries
 *  enough for the eligibility gate (`org_id`) alongside the judged-input shape. */
export interface JudgeableCandidate extends JudgedLessonInput {
  org_id?: string | null;
}

/**
 * Judge a shortlist of candidates against a free-text situation, using the
 * caller's own TypeSafe key. Returns a `ref → relevance` map on `applied`, or
 * `null` for EVERY OTHER outcome (skipped, timed out, rejected, malformed) —
 * `null` is the signal `withJudgedRelevance` (judgment.ts) treats as "run the
 * byte-identical baseline", per R8/R15.
 *
 * Never throws: every failure mode here is a reason to fall back to the
 * baseline ranking, not a reason to fail the read that feeds it.
 */
export async function judgeCandidates(
  userId: string,
  apiKey: string | null,
  version: number | null,
  situation: string,
  candidates: readonly JudgeableCandidate[],
  span: Span,
): Promise<Map<string, number> | null> {
  const config = resolveJudgmentConfig({ apiKey, env: Deno.env.toObject() });
  if (!config.enabled) {
    span.setAttributes({ 'lorekit.judgment.outcome': config.reason, 'lorekit.judgment.provider': JUDGMENT_PROVIDER });
    return null;
  }

  if (!situation.trim()) {
    span.setAttributes({ 'lorekit.judgment.outcome': 'skipped_no_query', 'lorekit.judgment.provider': JUDGMENT_PROVIDER });
    return null;
  }

  const eligible = candidates.filter(isJudgmentEligible);
  if (eligible.length === 0) {
    span.setAttributes({ 'lorekit.judgment.outcome': 'skipped_no_candidates', 'lorekit.judgment.provider': JUDGMENT_PROVIDER });
    return null;
  }

  const { body, questionIds } = buildJudgmentRequest(situation, eligible);
  const startedMs = Date.now();
  const callSpan = span.child('lorekit.judgment.rerank', {
    'lorekit.judgment.provider': JUDGMENT_PROVIDER,
    'lorekit.judgment.candidate_count': questionIds.length,
  }, SPAN_KIND_CLIENT);

  let outcome: JudgmentOutcome;
  let relevance: Map<string, number> | null = null;
  try {
    const res = await fetch(TYPESAFE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(JUDGMENT_TIMEOUT_MS),
    });

    if (!res.ok) {
      outcome = classifyHttpStatus(res.status);
      callSpan.clientError(`HTTP ${res.status}`);
    } else {
      const json = await res.json().catch(() => null);
      const parsed = parseJudgmentResponse(json, eligible);
      if (parsed.ok) {
        outcome = 'applied';
        relevance = parsed.relevance;
        callSpan.setAttributes({ 'lorekit.judgment.model': parsed.model ?? 'unknown' });
      } else {
        outcome = parsed.outcome;
        callSpan.clientError('malformed response');
      }
    }
  } catch (err) {
    outcome = classifyThrown(err);
    callSpan.error(outcome === 'timeout' ? 'TimeoutError' : (err as Error).name);
  } finally {
    callSpan
      .setAttributes({
        'lorekit.judgment.outcome': outcome!,
        'lorekit.judgment.duration_ms': Date.now() - startedMs,
      })
      .end();
  }

  span.setAttributes({
    'lorekit.judgment.outcome': outcome,
    'lorekit.judgment.provider': JUDGMENT_PROVIDER,
    'lorekit.judgment.candidate_count': questionIds.length,
  });

  // Best-effort, off the response's decision path — a failure to record must
  // never turn an already-computed judgment result into a thrown error.
  if (version !== null) {
    await recordJudgmentKeyCall(userId, JUDGMENT_PROVIDER, version, outcome, span);
  }

  return relevance;
}
