/**
 * Pure review-comment relevance classification — no I/O.
 *
 * A review agent posts a finding as a PR review comment.  Some time later that
 * thread is resolved, declined in a reply, thumbed down, or merged still open.
 * That outcome is the only honest signal available about whether the finding
 * was worth posting, and this module turns one thread's facts into either a
 * directional record or a documented refusal to write one.
 *
 * ── The rule underneath every branch ────────────────────────────────────────
 *
 * A DIRECTIONAL record requires corroborated evidence.  Where the evidence
 * cannot decide, write NOTHING.  Silence costs one signal; a wrong signal
 * trains a suppressor against a finding class that was never rejected, and the
 * suppressor is the thing that decides what a future review is allowed to say.
 * Every `write: false` verdict below is that rule firing, not a gap.
 *
 * ── What this module deliberately does not know ─────────────────────────────
 *
 * It does not know what any particular agent's identifier MEANS.  The value
 * pulled out of a comment marker is copied verbatim and treated as an opaque
 * string: never parsed, never split, never given meaning.  It carries no
 * severity vocabulary either — an agent's own comment-prefix conventions are
 * the agent's, and inventing a reading of them here is how a generic mechanism
 * silently becomes one consumer's mechanism.  See
 * `supabase/migrations/00102_github_relevance_configs.sql` for the four things
 * an installation declares instead.
 *
 * ── Interchangeability with the Actions-based writer ────────────────────────
 *
 * The record this produces is read by the same consumers as the one written by
 * a GitHub Actions workflow calling the CLI, so the field names and the three
 * closed vocabularies (`RelevanceOutcome`, `ResolutionMethod`,
 * `RelevanceDirection`) are a shared contract, not internal detail.  Changing
 * one of those strings changes what every existing reader sees.
 *
 * Self-contained mirror of packages/mcp-core/src/webhook/comment-relevance.ts,
 * duplicated rather than imported because this Edge Function is standalone Deno
 * with no cross-package imports — the same pattern used for
 * webhook-secret-select.ts and webhook-installation.ts.
 *
 * The mcp-core copy is the tested source of truth; keep the two in sync when
 * either changes (guarded by edge-parity.spec.ts).
 */

/** Did the outcome argue FOR this finding class or against it. */
export type RelevanceDirection = 'amplify' | 'suppress';

/**
 * How strongly.  `weak-not-relevant` is its own value because "open at merge
 * with nothing said about it" is much thinner evidence than "the author replied
 * that it was intentional", and collapsing the two would let neglect accumulate
 * into suppression at the same rate as an explicit decline.
 */
export type RelevanceOutcome = 'relevant' | 'not-relevant' | 'weak-not-relevant';

/** What actually happened to the thread. */
export type ResolutionMethod = 'fixed' | 'wont-fix' | 'ignored-at-merge';

export interface RelevanceRecordVerdict {
  write: true;
  outcome: RelevanceOutcome;
  method: ResolutionMethod;
  direction: RelevanceDirection;
  /** Human-readable justification, stored on the record. */
  reason: string;
}

export interface RelevanceSkipVerdict {
  write: false;
  /** Stable token, safe to use as an OTel attribute value. */
  skip: string;
  reason: string;
}

export type RelevanceVerdict = RelevanceRecordVerdict | RelevanceSkipVerdict;

/** GitHub's own answer about a review thread, or null when it could not be read. */
export interface ThreadState {
  isResolved: boolean;
  /** True when the anchored code no longer exists in the diff. */
  isOutdated: boolean;
}

/**
 * Whether a commit landed after the comment touched what the comment was about.
 *
 * `granularity` is `'line'` when the comment has a line anchor and `'file'`
 * when it does not (a file-level comment carries a path and no line).  The
 * file-level question is the honest weaker one: an untouched file is real
 * evidence that no fix landed, a touched file is evidence of nothing.
 *
 * `null` means the walk could not be completed — a read failure, or a commit
 * list longer than the caller was willing to fetch.  That is NOT the same as
 * `{ touched: false }`, and the merge-sweep table below keeps them apart:
 * reading an incomplete walk as "nothing was touched" is how a tooling limit
 * turns into a stream of false `ignored-at-merge` records.
 */
export interface TouchEvidence {
  touched: boolean;
  granularity: 'line' | 'file';
}

export interface ThreadFacts {
  state: ThreadState | null;
  /** Reply bodies after the root comment, in any order. */
  replies: readonly string[];
  /** Login that reacted 👎 to the root comment, or null. */
  thumbsDownBy: string | null;
  /** Root comment's anchor. `line` is null or 0 for a file-level comment. */
  path: string | null;
  line: number | null;
  /** Only consulted by `classifyMergedThread`. See `classifyResolvedThread`. */
  touch: TouchEvidence | null;
}

/**
 * Decline language in a reply.
 *
 * EVERY alternative carries \b on both sides.  Enumerating "the ones that could
 * match inside a word" is how this pattern was wrong three times running — each
 * fix bounded the reported instance and left the class.  Bound them all; the
 * cost of a boundary on a phrase that did not need one is zero.
 *
 *   intentional  else matches inside "unintentional"  ("That was unintentional - fixed")
 *   by design    else matches "by designers"          ("Reviewed by designers, then fixed")
 *   n/a          else matches inside a path fragment  ("Fixed, see src/bin/a.js")
 *   as designed  else matches "was designed"          ("This was designed upstream - fixed")
 *   wont fix     else matches "wont fixate"           ("I wont fixate on this, addressed it")
 *   nwf          else matches inside a longer token
 *
 * Each unbounded alternative turns an ordinary "fixed it" reply into a
 * `suppress` record for a fix that actually landed — the exact inversion this
 * whole module is written to avoid.
 */
export const DECLINE_PATTERN =
  /\bwon.?t\s+fix\b|\bwont\s+fix\b|\bby\s+design\b|\bintentional\b|\bnot\s+going\s+to\b|\bnwf\b|\bn\/a\b|\bout\s+of\s+scope\b|\bas\s+designed\b|\bworking\s+as\s+intended\b/i;

export function hasDeclineReply(replies: readonly string[]): boolean {
  return replies.some((body) => DECLINE_PATTERN.test(body ?? ''));
}

// ── Marker extraction ───────────────────────────────────────────────────────

/**
 * Charset and length the extracted identifier must satisfy.
 *
 * It becomes the suffix of a memory key, and the party supplying it is whoever
 * can comment on the pull request.  The prefix is the account's (see the
 * migration's security posture), so the blast radius is already bounded to one
 * namespace — this bounds the shape as well, so a key cannot carry a newline,
 * a quote, or ten kilobytes of prose.  Anything outside it is dropped, which is
 * the fail-closed direction: no record at all, never a record under a key
 * nobody can predict.
 */
export const SAFE_MARKER_VALUE = /^[A-Za-z0-9._:@/-]{1,200}$/;

export function isSafeMarkerValue(value: string): boolean {
  return SAFE_MARKER_VALUE.test(value);
}

/**
 * Pull the opaque identifier out of a comment body.
 *
 * Literal delimiters, not a regex: a caller-supplied regex compiled in an edge
 * function is a catastrophic-backtracking vector, and "reject the dangerous
 * patterns" is not a check that can be written soundly.  `indexOf` answers the
 * same question in linear time.
 *
 * Returns null — never a partial or a guess — when the open delimiter is
 * absent, the close delimiter does not follow it, or the value between them
 * fails `isSafeMarkerValue`.  A marker that looks authoritative but cannot be
 * validated is treated as no marker at all, because writing it anyway files a
 * record under a key derived from something unverified.
 */
export function extractMarkerValue(
  body: string | null | undefined,
  markerOpen: string,
  markerClose: string,
): string | null {
  if (!body || !markerOpen || !markerClose) return null;
  const start = body.indexOf(markerOpen);
  if (start < 0) return null;
  const valueStart = start + markerOpen.length;
  const end = body.indexOf(markerClose, valueStart);
  if (end < 0) return null;
  const value = body.slice(valueStart, end).trim();
  return isSafeMarkerValue(value) ? value : null;
}

/**
 * The key a classified outcome is filed under: the account's namespace plus the
 * opaque identifier, concatenated with nothing in between.
 *
 * No separator is inserted because the account's `key_prefix` already ends in
 * whatever separator its own reader expects — inserting one here would silently
 * re-key every record the moment this module shipped.
 */
export function buildRelevanceKey(keyPrefix: string, markerValue: string): string | null {
  if (!keyPrefix || !isSafeMarkerValue(markerValue)) return null;
  return `${keyPrefix}${markerValue}`;
}

// ── Touch evidence, derived from a unified diff ──────────────────────────────

/**
 * How far from the anchored line a hunk still counts as touching it.
 *
 * A fix rarely lands exactly on the commented line: it moves a guard two lines
 * up, or wraps the block. Zero radius would read most real fixes as "the region
 * was never touched" and file them as `ignored-at-merge`, which is the
 * inversion that matters here — so the radius errs toward UNDECIDABLE (write
 * nothing), never toward suppression.
 */
export const LINE_TOUCH_RADIUS = 10;

/**
 * Does a unified-diff patch modify within `radius` lines of `line` on the
 * RIGHT (post-image) side?
 *
 * Reads only the `@@ -a,b +c,d @@` headers, which is all that is needed: the
 * post-image start and length bound the region the hunk rewrote. A header with
 * no explicit length means one line (`@@ -1 +7 @@`), per the unified-diff
 * format — defaulting it to 0 would make a single-line fix invisible.
 */
export function patchTouchesLine(
  patch: string | null | undefined,
  line: number,
  radius: number = LINE_TOUCH_RADIUS,
): boolean {
  if (!patch || !Number.isFinite(line) || line <= 0) return false;
  const headers = patch.matchAll(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/g);
  for (const [, startStr, countStr] of headers) {
    const start = Number.parseInt(startStr, 10);
    const count = Number.parseInt(countStr ?? '1', 10);
    if (!Number.isFinite(start)) continue;
    const end = start + (Number.isFinite(count) ? count : 1);
    if (line >= start - radius && line <= end + radius) return true;
  }
  return false;
}

/**
 * One entry of GitHub's `compare` files array, narrowed to what the decision
 * below reads.  `patch` is OPTIONAL in the API, not merely sometimes empty.
 */
export interface ComparedFile {
  filename?: string;
  previous_filename?: string;
  patch?: string | null;
}

/**
 * A completed `compare` plus one thread's anchor → touch evidence, or `null`
 * when the pair cannot decide.
 *
 * This is the decision half of the `compare` probe, kept here rather than in
 * the edge fetch shell so it is testable and covered by the mirror's drift
 * guard.  The shell supplies `files` (`null` when the read failed or the array
 * was truncated) and owns nothing but the HTTP call and its memo.
 *
 * The `null` on an absent `patch` is the load-bearing line.  `compare` omits
 * `patch` for a binary file, for an entry past the per-file diff limit, and for
 * a pure rename — and this function is only reached at LINE granularity, where
 * "no hunks to look at" cannot distinguish "the line was not touched" from
 * "the hunks were not sent".  Answering `touched: false` there would hand the
 * merge sweep a fabricated negative and file an `ignored-at-merge` suppression
 * for a file the pull request demonstrably changed, which is the one inversion
 * `classifyMergedThread`'s `touch-undecidable` branch exists to prevent.
 *
 * An entry that is genuinely ABSENT from a completed walk is different, and
 * stays `touched: false`: the walk saw every changed file and this was not one
 * of them, which is real evidence that no fix landed.
 */
export function touchEvidenceFromFiles(
  files: readonly ComparedFile[] | null | undefined,
  path: string | null | undefined,
  line: number | null | undefined,
): TouchEvidence | null {
  if (!files || !path) return null;

  // Narrowed once, so the line-granularity branch below reads a `number` rather
  // than re-asserting one the ternary already established.
  const anchoredLine = typeof line === 'number' && line > 0 ? line : null;
  const granularity: TouchEvidence['granularity'] = anchoredLine === null ? 'file' : 'line';

  // A rename is a touch, and it changes the name the file is listed under — so
  // matching only `filename` reports a renamed file as never edited.
  const entry = files.find((f) => f.filename === path || f.previous_filename === path);
  if (!entry) return { touched: false, granularity };
  if (anchoredLine === null) return { touched: true, granularity };
  if (!entry.patch) return null;
  return { touched: patchTouchesLine(entry.patch, anchoredLine), granularity };
}

// ── Decision tables ─────────────────────────────────────────────────────────

/**
 * One RESOLVED thread → a verdict.
 *
 * Precedence: the author's own words and reactions outrank anything inferred
 * from the code, and an unreadable or dead anchor outranks both.
 *
 * `facts.touch` is deliberately NOT consulted.  Both of the inference branches
 * it could distinguish — "a commit touched the anchored region" and "resolved
 * with a live anchor and nothing declining it" — end at the same
 * `relevant / fixed` verdict, so the walk would buy a slightly richer `reason`
 * string for one GitHub API call per commit on the pull request.  That is the
 * whole reason this path is cheap enough to run inline on a webhook delivery.
 */
export function classifyResolvedThread(facts: ThreadFacts): RelevanceVerdict {
  if (facts.thumbsDownBy) {
    return {
      write: true,
      outcome: 'not-relevant',
      method: 'wont-fix',
      direction: 'suppress',
      reason: `Declined by a 👎 reaction from ${facts.thumbsDownBy}`,
    };
  }
  if (hasDeclineReply(facts.replies)) {
    return {
      write: true,
      outcome: 'not-relevant',
      method: 'wont-fix',
      direction: 'suppress',
      reason: 'A reply on the thread declines the finding',
    };
  }
  // Without thread state a fix cannot be told from a deletion, and the terminal
  // branch would assert acceptance on no evidence at all.
  if (!facts.state) {
    return {
      write: false,
      skip: 'thread-state-unavailable',
      reason: 'Thread state could not be read; the inference branch is unsound without it',
    };
  }
  if (facts.state.isOutdated) {
    return {
      write: false,
      skip: 'anchor-gone',
      reason:
        'Thread is outdated — the code the finding was about is gone, so its resolution says nothing about whether the finding was any good',
    };
  }
  return {
    write: true,
    outcome: 'relevant',
    method: 'fixed',
    direction: 'amplify',
    reason: 'Thread resolved with a live anchor and nothing declining it',
  };
}

/**
 * One thread as it stood AT MERGE → a verdict.
 *
 * `ignored-at-merge` is written only where the evidence actually supports it:
 * the thread was open, nobody declined it, the anchor is still live, and a
 * completed walk found no commit touching it.  Every other shape refuses.
 */
export function classifyMergedThread(facts: ThreadFacts): RelevanceVerdict {
  if (!facts.state) {
    return {
      write: false,
      skip: 'thread-state-unknown',
      reason: 'Thread state could not be read; that it was open at merge cannot be established',
    };
  }
  // The resolve trigger owns every resolved thread. Sweeping one again writes a
  // second — and usually opposite — record on the same key.
  if (facts.state.isResolved) {
    return {
      write: false,
      skip: 'already-classified-on-resolve',
      reason: 'Thread was resolved; the resolved-thread path owns its outcome',
    };
  }
  if (facts.thumbsDownBy) {
    return {
      write: true,
      outcome: 'not-relevant',
      method: 'wont-fix',
      direction: 'suppress',
      reason: `Declined by a 👎 reaction from ${facts.thumbsDownBy} with no reply`,
    };
  }
  if (hasDeclineReply(facts.replies)) {
    return {
      write: true,
      outcome: 'not-relevant',
      method: 'wont-fix',
      direction: 'suppress',
      reason: 'Thread was declined in a reply',
    };
  }
  if (facts.state.isOutdated) {
    return {
      write: false,
      skip: 'anchor-gone',
      reason: "Thread is outdated — the finding's subject is gone, so neither acceptance nor rejection happened",
    };
  }
  if (!facts.path) {
    return {
      write: false,
      skip: 'no-anchor',
      reason: 'Comment carries no path; there is nothing to corroborate against',
    };
  }
  // An incomplete walk is undecidable, NOT "untouched". Reading it the other way
  // converts a fetch budget into a stream of false suppressions.
  if (!facts.touch) {
    return {
      write: false,
      skip: 'touch-undecidable',
      reason: 'The commit walk did not complete, so no-fix-landed cannot be established',
    };
  }
  if (facts.touch.touched) {
    return {
      write: false,
      skip: 'region-edited',
      reason:
        facts.touch.granularity === 'line'
          ? 'A commit touched the commented region; the outcome is unknown, not ignored'
          : 'A commit touched the commented file and there is no line anchor to narrow to; the outcome is unknown, not ignored',
    };
  }
  return {
    write: true,
    outcome: 'weak-not-relevant',
    method: 'ignored-at-merge',
    direction: 'suppress',
    reason: `Thread on ${facts.path}:${facts.line || 0} was open at merge with no fix ${
      facts.touch.granularity === 'file' ? '(file untouched)' : 'commit'
    } and no decline`,
  };
}

// ── Record shape ────────────────────────────────────────────────────────────

export interface RelevanceRecordInput {
  verdict: RelevanceRecordVerdict;
  /** The opaque identifier, verbatim. */
  markerValue: string;
  /** What the installation declared its review agent is called. */
  agentName: string;
  /** Login and type of whoever authored the root comment. */
  commentAuthor: string | null;
  commentAuthorIsBot: boolean;
  pr: number;
  repo: string;
  commentId: number | null;
  /** ISO timestamp; injected so the record is deterministic under test. */
  now: string;
  ttlDays: number;
}

/**
 * The record body, as JSON-serialisable data.
 *
 * `status` is written as an ADVISORY snapshot and is always `'candidate'`.
 * Consumers recompute the lifecycle at read time from `seen_count` (which
 * LoreKit increments server-side on a repeat write to the same key) and the
 * distinct pull requests in `evidence[]`, so a lost read-modify-write here can
 * never reset a lifecycle — and this writer therefore does not need to read the
 * existing record before writing, which is what lets it run inside a webhook.
 *
 * `severity` is absent by design: grading a finding needs the agent's own
 * comment conventions, which this module does not know.  A consumer that wants
 * severity reads it from the comment itself.
 */
export function buildRelevanceRecord(input: RelevanceRecordInput): Record<string, unknown> {
  const { verdict } = input;
  return {
    v: 2,
    writer: 'github-app',
    fingerprint: input.markerValue,
    promotable: true,
    relevance: verdict.outcome,
    direction: verdict.direction,
    reason: verdict.reason,
    resolution_method: verdict.method,
    source: {
      login: input.commentAuthor,
      type: input.commentAuthorIsBot ? 'bot' : 'human',
      agent: input.agentName,
    },
    status: 'candidate',
    evidence: [
      {
        pr: input.pr,
        signal: verdict.method,
        at: input.now,
        by: input.commentAuthor,
      },
    ],
    examples: [`${input.repo}#${input.pr}${input.commentId ? ` comment ${input.commentId}` : ''}`],
    seen_count: 1,
    origin_pr: input.pr,
    expires: new Date(new Date(input.now).getTime() + input.ttlDays * 86_400_000).toISOString(),
  };
}
