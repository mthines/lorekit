// The deterministic grader.
//
// No model judges anything here. Success is exact string equality with the
// target scope; everything else is partial credit, and partial credit never
// becomes success. That rigidity is the point — a rubric a person has to
// interpret would drift between runs and make N=3 unreadable on top of being
// low-powered.
//
// TWO SOURCES, DELIBERATELY.
// The grader reads both what ended up in the STORE and what the agent
// ATTEMPTED, taken from the transcript, because neither alone is sufficient:
//
//   • Against the HOSTED store, an invalid scope is rejected by
//     `validateScope` (supabase/functions/mcp/tools.ts) and never lands — the
//     mistake exists only in the transcript.
//   • Against the OFFLINE store the harness uses, `store.write` performs NO
//     scope validation at all (verified: `branch:mthines/gw-tools` writes
//     successfully in local mode), so the mistake lands in the store and the
//     agent is never told. `lorekit lint`'s malformed-scope rule exists
//     precisely because offline stores accumulate these.
//
// Reading the union means the same grader is correct in both modes, and the
// `repeatedMistake` signal — the one the whole experiment turns on — cannot be
// lost to whichever mode a run happened to use.
import { validateScope } from "@lorekit/core/src/scope.ts";

import { TARGET_SCOPE } from "./task.mjs";
import { storeFor } from "./store-setup.mjs";

/** Scores. Exact match is the only success; the rest never reach it. */
export const SCORE_EXACT = 100;
export const SCORE_RIGHT_SCOPE_WRONG_FORM = 80;
export const SCORE_RIGHT_REPO_WRONG_BRANCH = 60;
export const SCORE_RIGHT_REPO_COARSE = 40;
export const SCORE_WROTE_SOMETHING = 20;
export const SCORE_NOTHING = 0;

export const MISTAKE_SINGLE_COLON = "single-colon";
export const MISTAKE_BRANCH_WITH_SLASH = "branch-appended-with-slash";
export const MISTAKE_BRANCH_MISSING = "branch-segment-missing";

/** Is this scope acceptable to the canonical validator? Never throws. */
export function isValidScope(scope) {
  try {
    validateScope(scope);
    return true;
  } catch {
    return false;
  }
}

/** The normalized (lowercased) form, or null when the scope is invalid. */
export function normalizeScope(scope) {
  try {
    return validateScope(scope);
  } catch {
    return null;
  }
}

/**
 * Classify an invalid scope as one of the two mistakes the canonical lesson
 * warns about, or null when it is invalid for some unrelated reason.
 *
 * Only invalid scopes are classified: a VALID scope is never a mistake, however
 * odd it looks, because the validator is the authority on that question.
 */
export function classifyMistake(scope) {
  if (typeof scope !== "string" || scope === "") return null;
  if (isValidScope(scope)) return null;

  // `branch:owner/repo` — a known prefix followed by exactly one colon.
  if (/^(global|project|repo|branch):(?!:)/.test(scope)) {
    return MISTAKE_SINGLE_COLON;
  }
  // A `branch::` scope with only one `::` is missing its second separator, but
  // there are TWO distinct recall failures behind that shape and the experiment
  // reads them separately:
  //
  //   branch::owner/repo/branch  — the branch appended with `/` instead of `::`
  //   branch::owner/repo         — the branch segment omitted altogether
  //
  // Collapsing them would make `mistakes` report a slash the agent never wrote.
  if (
    scope.startsWith("branch::") &&
    !scope.slice("branch::".length).includes("::")
  ) {
    const segments = scope.slice("branch::".length).split("/");
    const looksLikeOwnerRepo =
      segments.length >= 2 &&
      /^[\w.-]+$/.test(segments[0]) &&
      /^[\w.-]+$/.test(segments[1]);
    if (!looksLikeOwnerRepo) return null;
    // Anything after `owner/repo` is the branch, glued on with `/`.
    const appended = segments.slice(2).join("/");
    return appended === "" ? MISTAKE_BRANCH_MISSING : MISTAKE_BRANCH_WITH_SLASH;
  }
  return null;
}

/** The `owner/repo` a scope names, or null. Works for repo:: and branch::. */
export function repoOf(scope) {
  const normalized = normalizeScope(scope);
  if (!normalized) return null;
  if (normalized.startsWith("repo::")) return normalized.slice("repo::".length);
  if (normalized.startsWith("branch::")) {
    return normalized.slice("branch::".length).split("::")[0];
  }
  return null;
}

/**
 * Grade one attempt from the scopes it produced.
 *
 * Pure: takes the two string lists and returns the verdict, so the whole rubric
 * is testable against hand-written store states with no sandbox, no store and
 * no model.
 *
 * @param {object}   args
 * @param {string[]} args.storedScopes     scopes present in the store afterwards
 * @param {string[]} [args.attemptedScopes] scopes passed to memory.write
 * @param {string}   [args.target]         the scope that counts as success
 * @returns {{ success: boolean, score: number, repeatedMistake: boolean,
 *             mistakes: object[], matchedScope: string|null, detail: string }}
 */
export function grade({
  storedScopes = [],
  attemptedScopes = [],
  target = TARGET_SCOPE,
} = {}) {
  const stored = storedScopes.filter((s) => typeof s === "string" && s !== "");
  const attempted = attemptedScopes.filter(
    (s) => typeof s === "string" && s !== "",
  );
  const seen = [...new Set([...stored, ...attempted])];
  const targetRepo = repoOf(target);

  // Every mistake the agent made, from either source. A rejected attempt is
  // still a mistake even though it left no trace in the store.
  const mistakes = [];
  for (const scope of seen) {
    const kind = classifyMistake(scope);
    if (kind) mistakes.push({ scope, kind });
  }
  const repeatedMistake = mistakes.length > 0;

  // Success is decided by the STORE alone. An attempt that was rejected did
  // not record the lesson, and the task is to record it.
  const exact = stored.find((s) => s === target) || null;
  if (exact) {
    return {
      success: true,
      score: SCORE_EXACT,
      repeatedMistake,
      mistakes,
      matchedScope: exact,
      detail: `stored the exact target scope ${target}`,
    };
  }

  // Partial credit, best-first. Every branch below is a FAILURE.
  const validStored = stored.filter(isValidScope).map(normalizeScope);
  const normalizedTarget = normalizeScope(target) || target;

  // The agent named the right repo AND the right branch, but the stored string
  // is not the target verbatim — it differs only by case or surrounding
  // whitespace, which `validateScope` folds away. This is NOT the 60 band: the
  // rubric reserves 60 for a branch that actually differs, and reporting it as
  // "the wrong branch" would misread the transcript. It is still a failure,
  // because success is exact equality with what the store holds.
  const rightScopeWrongForm = stored.find(
    (s) => s !== target && normalizeScope(s) === normalizedTarget,
  );
  if (rightScopeWrongForm) {
    return {
      success: false,
      score: SCORE_RIGHT_SCOPE_WRONG_FORM,
      repeatedMistake,
      mistakes,
      matchedScope: rightScopeWrongForm,
      detail:
        `normalizes to the target but was not stored verbatim: ` +
        `${JSON.stringify(rightScopeWrongForm)} vs ${JSON.stringify(target)}`,
    };
  }

  const rightRepoBranch = validStored.find(
    (s) => s.startsWith("branch::") && repoOf(s) === targetRepo,
  );
  if (rightRepoBranch) {
    return {
      success: false,
      score: SCORE_RIGHT_REPO_WRONG_BRANCH,
      repeatedMistake,
      mistakes,
      matchedScope: rightRepoBranch,
      detail: `branch scope for the right repo but the wrong branch: ${rightRepoBranch}`,
    };
  }

  const rightRepoCoarse = validStored.find(
    (s) => s.startsWith("repo::") && repoOf(s) === targetRepo,
  );
  if (rightRepoCoarse) {
    return {
      success: false,
      score: SCORE_RIGHT_REPO_COARSE,
      repeatedMistake,
      mistakes,
      matchedScope: rightRepoCoarse,
      detail: `right repo at the wrong granularity: ${rightRepoCoarse}`,
    };
  }

  if (stored.length > 0) {
    return {
      success: false,
      score: SCORE_WROTE_SOMETHING,
      repeatedMistake,
      mistakes,
      matchedScope: stored[0],
      detail: `wrote at an invalid or unrelated scope: ${stored.join(", ")}`,
    };
  }

  return {
    success: false,
    score: SCORE_NOTHING,
    repeatedMistake,
    mistakes,
    matchedScope: null,
    detail:
      attempted.length > 0
        ? `nothing was stored; ${attempted.length} attempt(s) were rejected`
        : "nothing was written",
  };
}

/**
 * Every scope the agent passed to `memory.write`, in order, read out of a
 * stream-json transcript.
 *
 * The tool name is matched by SUFFIX (`…memory_write`) exactly as the CLI's own
 * Claude adapter does, so any MCP server label works. Total: malformed lines,
 * absent inputs and non-string scopes are skipped, never thrown on.
 */
export function attemptedScopesFromTranscript(transcriptText) {
  if (typeof transcriptText !== "string" || transcriptText === "") return [];
  const scopes = [];
  for (const line of transcriptText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const content =
      entry && entry.message && Array.isArray(entry.message.content)
        ? entry.message.content
        : null;
    if (!content) continue;
    for (const item of content) {
      if (!item || item.type !== "tool_use") continue;
      if (
        typeof item.name !== "string" ||
        !item.name.endsWith("memory_write")
      ) {
        continue;
      }
      const scope = item.input && item.input.scope;
      if (typeof scope === "string" && scope !== "") scopes.push(scope);
    }
  }
  return scopes;
}

/**
 * Grade a finished attempt against its sandbox.
 *
 * Store scopes come from `listScopes()` — the store's own recursive walk, which
 * reconstructs each entry's scope verbatim from its frontmatter rather than
 * reverse-mapping the directory layout (that mapping is lossy for `project::`).
 * Enumerating rather than probing known scopes matters here: the agent may have
 * written somewhere nobody predicted, and a grader that only looked where it
 * expected would score that as "nothing written".
 */
export async function gradeSandbox(
  sandbox,
  { transcriptText = "", target = TARGET_SCOPE } = {},
) {
  const { store } = storeFor(sandbox);
  const inventory = await store.listScopes();
  const storedScopes = (Array.isArray(inventory) ? inventory : []).map(
    (row) => row.scope,
  );
  const attemptedScopes = attemptedScopesFromTranscript(transcriptText);
  return {
    ...grade({ storedScopes, attemptedScopes, target }),
    storedScopes,
    attemptedScopes,
  };
}
