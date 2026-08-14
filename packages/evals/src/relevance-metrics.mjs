// The retrieval-relevance metrics: precision@k, recall@k, MRR.
//
// Pure and deterministic — takes a ranked list of retrieved keys and a set of
// ground-truth keys, returns numbers. No store, no sandbox, no model, so the
// whole thing is exercised by `node --test` in milliseconds (the package's
// "everything below the model is a deterministic, tested function" split).
//
// These COMPLEMENT the live `claude -p` eval; they never gate it. The live eval
// measures whether an injected lesson changes the agent's output. These measure
// whether the RETRIEVER surfaces the right lessons in the first place — the
// upstream half of the same question — against a ground truth pinned to the real
// outcome signal (see `ground-truth.mjs`).

/**
 * The loud caveat that travels with every metrics object built on the bootstrap
 * seed. It is embedded in the DATA, not just the README, so a `summary.json`
 * read months later cannot be mistaken for a real baseline — the same reason the
 * N=3 caveat lives in the arm summaries.
 */
export const BOOTSTRAP_WARNING =
  "BOOTSTRAP PLACEHOLDER baseline (2-row seed derived from the in-repo mock). " +
  "These numbers MUST NOT be used to gate downstream PRs (e.g. A1/A4) until " +
  "`bin/mine-ground-truth.mjs` has been run against the hosted store and a real " +
  "fixtures/ground-truth.real.json snapshot has been committed.";

export const BASELINE_BOOTSTRAP = "bootstrap-seed";
export const BASELINE_REAL = "real-hosted-snapshot";

/** Coerce to a clean array of string keys, dropping non-strings. */
function keyList(value) {
  return (Array.isArray(value) ? value : []).filter((k) => typeof k === "string");
}

/**
 * A normalized positive integer `k`.
 *
 * ABSENT (`undefined`/`null`) means "the caller did not pick a k" and takes the
 * fallback. A PRESENT but unusable `k` — `"x"`, `0`, `-1`, `NaN` — is a caller
 * MISTAKE and throws: silently rewriting it to the fallback made `ks: [1, "x"]`
 * collapse to a single entry in `precisionAtK` instead of surfacing the bad
 * input. A safe default makes an OMITTED input safe; it never makes a MALFORMED
 * one correct.
 */
function normalizeK(k, fallback) {
  if (k === undefined || k === null) return fallback;
  const n = Math.floor(Number(k));
  if (!Number.isFinite(n) || n <= 0) {
    throw new TypeError(
      `k must be a positive integer (or omitted); received ${JSON.stringify(k)}`,
    );
  }
  return n;
}

/**
 * precision@k — of the top `k` retrieved keys, the fraction that are relevant.
 *
 * When fewer than `k` items were retrieved, the denominator is the number
 * actually retrieved (not `k`): precision asks "how much of what I showed was
 * right", and padding the denominator to `k` would punish a short-but-correct
 * list. An empty retrieval scores 0.
 */
export function precisionAtK(ranked, groundTruthKeys, k) {
  const items = keyList(ranked);
  const truth = new Set(keyList(groundTruthKeys));
  const kk = normalizeK(k, items.length || 1);
  const top = items.slice(0, kk);
  if (top.length === 0) return 0;
  const hits = top.filter((key) => truth.has(key)).length;
  return hits / top.length;
}

/**
 * recall@k — of all relevant keys, the fraction that appear in the top `k`.
 *
 * The denominator is the ground-truth size. An empty ground truth is undefined
 * recall; we return 1 (there was nothing to miss) so a query with no relevant
 * items does not drag an average to 0 — callers that care can filter on
 * `groundTruthSize === 0`.
 */
export function recallAtK(ranked, groundTruthKeys, k) {
  const truth = new Set(keyList(groundTruthKeys));
  if (truth.size === 0) return 1;
  const items = keyList(ranked);
  const kk = normalizeK(k, items.length || 1);
  const top = items.slice(0, kk);
  const found = top.filter((key) => truth.has(key)).length;
  return found / truth.size;
}

/**
 * Mean Reciprocal Rank for a SINGLE ranked list: 1 / (rank of the first relevant
 * key), ranks 1-based. No relevant key in the list → 0.
 *
 * "Mean" is a misnomer for one query; `meanReciprocalRank` below averages this
 * over many queries, which is the actual MRR.
 */
export function reciprocalRank(ranked, groundTruthKeys) {
  const items = keyList(ranked);
  const truth = new Set(keyList(groundTruthKeys));
  for (let i = 0; i < items.length; i += 1) {
    if (truth.has(items[i])) return 1 / (i + 1);
  }
  return 0;
}

/** MRR across many (ranked, groundTruth) query results. Empty → 0. */
export function meanReciprocalRank(queryResults = []) {
  const rows = Array.isArray(queryResults) ? queryResults : [];
  if (rows.length === 0) return 0;
  const sum = rows.reduce(
    (acc, r) => acc + reciprocalRank(r?.ranked, r?.groundTruth),
    0,
  );
  return sum / rows.length;
}

/**
 * `mrr` — convenience alias for the single-list reciprocal rank, so a caller
 * with one query reads `mrr(ranked, truth)` rather than wrapping it in an array.
 * The multi-query average is `meanReciprocalRank`.
 */
export const mrr = reciprocalRank;

/**
 * Score one retrieval against one ground-truth set at a set of `k` values, and
 * stamp the result with the baseline provenance + (for a seed) the loud caveat.
 *
 * @param {object}   args
 * @param {string[]} args.ranked        retriever output, best-first
 * @param {object}   args.groundTruth   a `buildGroundTruth` result (or `{ keys }`)
 * @param {number[]} [args.ks]          k values to report (default [1, 3, 5])
 * @param {string}   [args.baselineSource] BASELINE_BOOTSTRAP | BASELINE_REAL
 * @returns {{ baseline: {source,rowCount,warning|null},
 *            groundTruthSize: number,
 *            precisionAtK: object, recallAtK: object, mrr: number }}
 */
export function scoreRanking({
  ranked = [],
  groundTruth = { keys: [] },
  ks = [1, 3, 5],
  baselineSource = BASELINE_BOOTSTRAP,
} = {}) {
  const truthKeys = keyList(groundTruth.keys);
  const kValues = (Array.isArray(ks) ? ks : [1, 3, 5]).map((k) =>
    normalizeK(k, 1),
  );

  const precision = {};
  const recall = {};
  for (const k of kValues) {
    precision[k] = precisionAtK(ranked, truthKeys, k);
    recall[k] = recallAtK(ranked, truthKeys, k);
  }

  const source = baselineSource === BASELINE_REAL ? BASELINE_REAL : BASELINE_BOOTSTRAP;
  return {
    baseline: {
      source,
      rowCount: truthKeys.length,
      warning: source === BASELINE_BOOTSTRAP ? BOOTSTRAP_WARNING : null,
    },
    groundTruthSize: truthKeys.length,
    precisionAtK: precision,
    recallAtK: recall,
    mrr: reciprocalRank(ranked, truthKeys),
  };
}
