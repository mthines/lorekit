#!/usr/bin/env node
/**
 * Deploy-scope resolver (deploy-time).
 *
 * Decides which halves of the product `deploy.yml` deploys on a merge to main:
 * the API (Supabase edge functions + migrations) and the web dashboard (Next.js
 * on Vercel). Extracted from the workflow for the same reason
 * `check-remote-migration-drift.mjs` was — it decides whether production is
 * touched, so it needs a test rather than a shell block nobody can run.
 *
 * WHAT CHANGED, AND WHY.
 *
 * The rule used to be "diff this push (`github.event.before...HEAD`) against the
 * path globs", justified as: lockstep only matters when both halves change, and
 * then both run and flip together. That holds only while every both-halves merge
 * actually REACHES production. One whose deploy fails does not, and then the
 * next single-half merge promotes past it:
 *
 *   • #492 changed both halves. Its `smoke-preview` failed, so `deploy-production`
 *     and `promote-web-production` were both skipped. Correct — lockstep held.
 *   • #504 changed only `packages/web/**`. Diffed against its own parent that is
 *     api=false, so `promote-web-production` took its `api == 'false'` branch and
 *     assigned the production domain to a bundle built from HEAD — which carried
 *     #492's client. That client POSTs `/functions/v1/memories/list`, a route the
 *     production edge functions had never been given, so every production Lore
 *     Explorer read answered 405 until the web was rolled back by hand.
 *
 * So the baseline is not "the previous commit", it is "the commit this half is
 * actually serving". Each half is diffed against its own deployed-SHA marker
 * (`deployed/api-production` / `deployed/web-production`), which only the job
 * that performed that half's production flip moves, and only on success.
 * Undeployed work therefore stays in the diff until it deploys.
 *
 * The markers are ADVISORY. Any doubt about one resolves to the push baseline —
 * the previous behaviour — never to "this half has no changes", because the
 * failure mode of a wrong `false` is the incident above while the failure mode
 * of a wrong `true` is a redundant deploy of an unchanged half.
 *
 * Usage (from a full-history checkout):
 *
 *   node scripts/resolve-deploy-scope.mjs
 *
 * Reads DEPLOY_TARGET, BEFORE, API_DEPLOYED_TAG, WEB_DEPLOYED_TAG from the
 * environment; writes `api` and `web` to $GITHUB_OUTPUT when set, and a human
 * summary to stdout and $GITHUB_STEP_SUMMARY. Always exits 0 — this classifies,
 * it does not gate.
 *
 * The two baselines it chose are reported to stdout and the step summary, not to
 * $GITHUB_OUTPUT: they are there to make a run readable, and an output nothing
 * declares in the job's `outputs:` is a contract with no consumer.
 */

import { execFileSync } from 'node:child_process';

/**
 * Path globs, as anchored regexes over `git diff --name-only` output.
 *
 * `packages/schemas/` is in BOTH: the edge functions mirror it and the web
 * transpiles it. The workspace manifests and this pipeline's own files force
 * both, so a change to the deploy machinery always exercises the whole thing —
 * which is also what makes the FIRST run after this lands deploy both halves and
 * mint both markers.
 */
export const API_PATHS =
  /^(packages\/mcp-core\/|packages\/mcp-server\/|packages\/schemas\/|supabase\/functions\/|supabase\/migrations\/|supabase\/tests\/|supabase\/config\.toml|package\.json|pnpm-lock\.yaml|nx\.json|scripts\/resolve-deploy-scope\.mjs|\.github\/workflows\/deploy\.yml)/;

export const WEB_PATHS =
  /^(packages\/web\/|packages\/schemas\/|package\.json|pnpm-lock\.yaml|nx\.json|scripts\/resolve-deploy-scope\.mjs|\.github\/actions\/vercel-preview-deploy\/|\.github\/workflows\/deploy\.yml)/;

/**
 * A `workflow_dispatch` run can force what deploys, bypassing detection.
 * `auto` (and any push, where the input is empty) returns null → detect.
 */
export function resolveManualTarget(target) {
  switch (target) {
    case 'all':
      return { api: true, web: true };
    case 'api':
      return { api: true, web: false };
    case 'web':
      return { api: false, web: true };
    default:
      return null;
  }
}

/**
 * Choose a half's diff baseline.
 *
 * `tagSha` is the marker's commit (null when the marker does not exist, has not
 * been fetched, or has been garbage-collected). `tagIsAncestor` says whether it
 * is reachable from HEAD.
 *
 * A marker that is NOT an ancestor of HEAD is unusable: after a revert, or on a
 * re-run of an older ref, `git diff <marker>..HEAD` reports the marker-only files
 * as changed, which is a true statement about the diff and a misleading one about
 * this merge. Fall back and let the push decide — one redundant deploy, no skips.
 *
 * `pushBase` is itself null when there is no usable push baseline either (a root
 * commit, or a checkout with no parent reachable). `base: null` then means "no
 * baseline at all" and the caller must treat EVERY tracked file as changed —
 * never "nothing changed", which is the one answer this module must never
 * produce out of doubt.
 */
export function pickBaseline({ tagSha, tagIsAncestor, pushBase }) {
  const fallback = pushBase
    ? { base: pushBase, source: 'push' }
    : { base: null, source: 'no baseline — every tracked file' };
  if (!tagSha) return fallback;
  if (!tagIsAncestor) {
    return { ...fallback, source: `${fallback.source}, marker not an ancestor of HEAD` };
  }
  return { base: tagSha, source: 'deployed' };
}

/** Does any changed path fall in this half? */
export function halfChanged(changedFiles, paths) {
  return changedFiles.some((f) => paths.test(f));
}

/**
 * The whole decision, given the two already-computed file lists.
 *
 * Kept separate from every git call so the interesting cases — the ones the
 * incident turned on — are assertable without a repository.
 */
export function classify({ apiChangedFiles, webChangedFiles }) {
  return {
    api: halfChanged(apiChangedFiles, API_PATHS),
    web: halfChanged(webChangedFiles, WEB_PATHS),
  };
}

// ── IO seam ──────────────────────────────────────────────────────────────────

/**
 * The one place this module shells out. Everything below takes it as an
 * injectable argument so the marker-to-baseline wiring — the part the incident
 * actually turned on — is assertable without a repository, a tag, or a reflog.
 *
 * `run` returns trimmed stdout and throws on a non-zero exit; `ok` reports the
 * exit status of a command run for its status alone.
 */
export const execGit = {
  run: (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim(),
  ok: (...args) => {
    try {
      execFileSync('git', args, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
};

/** Resolve a tag to a commit sha, or null when it is not present. */
export function tagCommit(tag, git = execGit) {
  try {
    return git.run('rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`) || null;
  } catch {
    return null;
  }
}

/**
 * The push baseline — `github.event.before`, or HEAD~1 when it is unusable.
 *
 * Returns null when neither is available (a root commit, or a checkout whose
 * parent is not present). It must NOT fall back to HEAD: `git diff HEAD HEAD` is
 * empty, so both halves would resolve false — the single doubt path that answers
 * "this half has no changes", which is exactly the answer the incident was made
 * of. A null baseline makes `changedSince` list every tracked file instead.
 */
export function pushBaseline(before, git = execGit) {
  const usable =
    before &&
    before !== '0000000000000000000000000000000000000000' &&
    git.ok('cat-file', '-e', `${before}^{commit}`);
  if (usable) return before;
  try {
    return git.run('rev-parse', 'HEAD~1');
  } catch {
    return null;
  }
}

/**
 * One half's baseline: read its marker, ask whether HEAD can reach it, and let
 * the pure `pickBaseline` decide. The `tagIsAncestor` probe is deliberately
 * skipped when there is no marker — `merge-base --is-ancestor` with an empty
 * argument is a usage error, not a `false`.
 */
export function resolveHalf(tag, { pushBase, git = execGit } = {}) {
  const tagSha = tagCommit(tag, git);
  return pickBaseline({
    tagSha,
    tagIsAncestor: tagSha ? git.ok('merge-base', '--is-ancestor', tagSha, 'HEAD') : false,
    pushBase,
  });
}

/** Files changed since `base`, or every tracked file when there is no baseline. */
export function changedSince(base, git = execGit) {
  const out = base ? git.run('diff', '--name-only', base, 'HEAD') : git.run('ls-files');
  return out.split('\n').filter(Boolean);
}

const invokedDirectly = process.argv[1] && /resolve-deploy-scope\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const {
    DEPLOY_TARGET = '',
    BEFORE = '',
    API_DEPLOYED_TAG = 'deployed/api-production',
    WEB_DEPLOYED_TAG = 'deployed/web-production',
    GITHUB_OUTPUT,
    GITHUB_STEP_SUMMARY,
  } = process.env;

  const lines = [];
  let scope;

  const manual = resolveManualTarget(DEPLOY_TARGET);
  if (manual) {
    scope = manual;
    lines.push(`### Deploy scope (manual override: \`${DEPLOY_TARGET}\`)`);
  } else {
    // Every git call below can throw (no repository, a corrupt object store, a
    // git that is not on PATH). The header promises this always exits 0, and a
    // non-zero exit would red the `changes` job and stop the deploy — so a throw
    // must land where every other doubt in this module lands: BOTH halves true,
    // one redundant deploy, never a skip.
    try {
      const pushBase = pushBaseline(BEFORE);
      const api = resolveHalf(API_DEPLOYED_TAG, { pushBase });
      const web = resolveHalf(WEB_DEPLOYED_TAG, { pushBase });
      const apiChangedFiles = changedSince(api.base);
      const webChangedFiles = changedSince(web.base);
      scope = classify({ apiChangedFiles, webChangedFiles });

      const shown = (base) => base ?? 'none';
      console.log(`API baseline  ${shown(api.base)} (${api.source})`);
      console.log(apiChangedFiles.join('\n'));
      console.log(`Web baseline  ${shown(web.base)} (${web.source})`);
      console.log(webChangedFiles.join('\n'));

      lines.push('### Deploy scope');
      lines.push(`- API baseline: \`${shown(api.base)}\` (${api.source})`);
      lines.push(`- Web baseline: \`${shown(web.base)}\` (${web.source})`);
    } catch (error) {
      scope = { api: true, web: true };
      console.error(`Deploy-scope detection failed, deploying both halves: ${error.message}`);
      lines.push('### Deploy scope (detection failed — both halves)');
      lines.push(`- \`${error.message}\``);
    }
  }

  lines.push(`- API (Supabase): ${scope.api}`);
  lines.push(`- Web (Vercel): ${scope.web}`);
  console.log(`api=${scope.api} web=${scope.web}`);

  const { appendFileSync } = await import('node:fs');
  if (GITHUB_OUTPUT) {
    appendFileSync(
      GITHUB_OUTPUT,
      `api=${scope.api}\nweb=${scope.web}\n`,
    );
  }
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}
