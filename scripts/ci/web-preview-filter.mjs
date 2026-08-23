#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// The CANONICAL path filter that decides whether a change spends a Vercel
// PREVIEW DEPLOYMENT.
//
// Vercel's per-day deployment quota is the scarce resource here, so this list
// answers exactly one question: "can this file change what the deployed
// dashboard looks like, or how it gets deployed?" It is deliberately NARROWER
// than ci.yml's `web` filter, which gates the (free) Storybook visual-regression
// job — that one can afford to be jumpy; this one cannot.
//
// Two YAML copies exist because neither consumer can import this file:
//
//   1. `.github/workflows/ci.yml` — the `changes` job's `web_preview` grep. That
//      job runs before any toolchain setup and stays dependency-free like its
//      five sibling gates.
//   2. `.github/workflows/web-preview-deploy.yml` — the `web-path-filter` input
//      default, used by the incremental "did a web file change since this PR's
//      last preview?" check. That step runs BEFORE the checkout (deliberately —
//      it decides using only the GitHub API), so there is no repo file to read.
//
// Both copies are held to this string by assertion, not by discipline:
// `web-preview-filter.test.mjs` fails when either drifts. Same pattern as
// READ_TOOLS/WRITE_TOOLS vs the tool catalog — the duplication is the interface,
// the test is the guarantee.
//
// Written as a POSIX extended regex so ONE string works under both `grep -E`
// (ci.yml) and a JS `RegExp` (github-script). The `$` anchors inside the
// alternation are load-bearing — without them `package.json.bak` matches — and
// the test proves grep and RegExp agree on every case.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Paths whose change requires a new preview deployment.
 *
 * - `packages/web/`     — the dashboard itself.
 * - `packages/schemas/` — a `workspace:*` dependency compiled into the app.
 * - `package.json`      — the ROOT manifest only (pnpm overrides reach into the
 *                        dashboard's dependency graph). A per-package manifest
 *                        is covered by its own prefix, or not web at all.
 * - `nx.json`           — task-graph/build configuration.
 * - the composite action + the two `web-preview*` workflows — the preview
 *   machinery itself, so a change to how previews are built gets verified by
 *   actually building one.
 *
 * Deliberately ABSENT:
 * - `.github/workflows/ci.yml` — every other gate in that file includes itself
 *   so the guard is exercised on its own PR, but for THIS gate that means every
 *   unrelated CI edit (a new test step, a cache key, another job entirely)
 *   spends a deployment. The `web-preview` job's own wiring lives in ci.yml, so
 *   the trade is real; `/web-preview` covers the rare case where you changed
 *   that wiring and want to watch it run.
 * - `pnpm-lock.yaml` — it moves on every dependency change anywhere in the
 *   monorepo, and the ones that reach the dashboard also touch
 *   `packages/web/package.json`, `packages/schemas/`, or the root manifest,
 *   which are all listed above. A relock with no manifest change (or one in
 *   another package) cannot change what the dashboard renders.
 */
export const WEB_PREVIEW_PATH_FILTER =
  '^(packages/web/|packages/schemas/|package\\.json$|nx\\.json$|\\.github/actions/vercel-preview-deploy/|\\.github/workflows/(web-preview|web-preview-deploy)\\.yml$)';

/** Does this repo-relative path require a new preview deployment? */
export function matchesWebPreviewPath(filename) {
  return new RegExp(WEB_PREVIEW_PATH_FILTER).test(filename);
}

/** Does any path in this list require a new preview deployment? */
export function anyWebPreviewPath(filenames) {
  const re = new RegExp(WEB_PREVIEW_PATH_FILTER);
  return filenames.some((f) => re.test(f));
}

// CLI: answer "would these files have deployed a preview?" — the question you
// ask when a PR deployed one you did not expect, or skipped one you did.
//   node scripts/ci/web-preview-filter.mjs --print
//   node scripts/ci/web-preview-filter.mjs <path>...
//   git diff --name-only main... | xargs node scripts/ci/web-preview-filter.mjs
// Exits 0 when at least one path matches (a preview would deploy), 1 when none.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === '--print') {
    console.log(WEB_PREVIEW_PATH_FILTER);
    process.exit(0);
  }
  if (args.length === 0) {
    console.error('usage: web-preview-filter.mjs [--print | <path>...]');
    process.exit(2);
  }
  let any = false;
  for (const path of args) {
    const hit = matchesWebPreviewPath(path);
    any ||= hit;
    console.log(`${hit ? 'preview' : '   skip'}  ${path}`);
  }
  console.log(any ? '\n→ a preview WOULD deploy' : '\n→ no preview (no web-relevant path)');
  process.exit(any ? 0 : 1);
}
