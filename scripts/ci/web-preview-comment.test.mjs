// Unit tests for the sticky web-preview comment body.
//
// The body is READ BY MACHINES — both by this repo's own "Decide whether a
// redeploy is needed" step (which pulls the deployed SHA out of the marker) and
// by external tooling that scrapes a PR for its preview URL, which was written
// against Vercel's comment shape. So the assertions below are not about
// prettiness: each one pins a structure some parser keys on.
//
// The Vercel-shaped anchors are re-derived here the way a scraper would find
// them (a header match, a `[Preview](…)` regex) rather than compared to a
// snapshot, so a cosmetic edit stays free while a shape change goes red.
//
// Run: node --test scripts/ci/web-preview-comment.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  WEB_PREVIEW_MARKER,
  formatUpdatedLabel,
  renderReadyComment,
  renderErrorComment,
} from './web-preview-comment.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

const SHA = '4f307759b0f7c85ab9f13172ee59de4747aa8c0a';
const PREVIEW_URL = 'https://lorekit-pr-629-mads-thines-projects.vercel.app';
const COMMIT_URL = 'https://lorekit-65k6q0gu9-mads-thines-projects.vercel.app';
const RUN_URL = 'https://github.com/mthines/lorekit/actions/runs/33548435410';
const AT = new Date('2026-09-01T19:17:00.000Z');

const ready = (over = {}) =>
  renderReadyComment({
    sha: SHA,
    previewUrl: PREVIEW_URL,
    commitUrl: COMMIT_URL,
    aliasAvailable: true,
    forced: false,
    runUrl: RUN_URL,
    at: AT,
    ...over,
  });

const errored = (over = {}) =>
  renderErrorComment({ sha: SHA, detail: 'Deployment blocked.', runUrl: RUN_URL, at: AT, ...over });

// ── The Vercel-shaped table ──────────────────────────────────────────────────
// Verbatim from a real Vercel comment. If Vercel ever changes these, THIS is
// the line to change — everything else about the format follows from it.
const VERCEL_HEADER = '| Project | Deployment | Actions | Updated |';
const VERCEL_ALIGNMENT = '| :--- | :----- | :------ | :------ |';

test('the table header and alignment row are Vercel\'s, verbatim', () => {
  for (const body of [ready(), errored()]) {
    const lines = body.split('\n');
    const header = lines.indexOf(VERCEL_HEADER);
    assert.notEqual(header, -1, 'the Vercel column header is missing');
    assert.equal(lines[header + 1], VERCEL_ALIGNMENT);
    // Exactly one project row follows the alignment row.
    assert.match(lines[header + 2], /^\| \*\*lorekit\*\* \|/);
  }
});

test('the preview URL is reachable through Vercel\'s `[Preview](…)` anchor', () => {
  // The extraction an external scraper performs, spelled out.
  const found = ready().match(/\[Preview\]\((https?:\/\/[^)\s]+)\)/);
  assert.ok(found, 'no `[Preview](…)` link — this is the anchor preview-URL scrapers key on');
  assert.equal(found[1], PREVIEW_URL);
});

test('the Deployment cell carries Vercel\'s status icon and a `[Ready](…)` link', () => {
  const body = ready();
  assert.ok(body.includes('![Ready](https://vercel.com/static/status/ready.svg)'));
  // `(?<!!)` so the status IMAGE — `![Ready](…svg)` — is not mistaken for the link.
  const found = body.match(/(?<!!)\[Ready\]\((https?:\/\/[^)\s]+)\)/);
  assert.ok(found, 'no `[Ready](…)` link in the Deployment column');
  // Deployment is the IMMUTABLE per-commit build, never the moving alias.
  assert.equal(found[1], COMMIT_URL);
});

test('the Updated cell is a `<relative-time>` element with a parseable datetime', () => {
  for (const body of [ready(), errored()]) {
    const found = body.match(/<relative-time datetime="([^"]+)">([^<]+)<\/relative-time>/);
    assert.ok(found, 'no `<relative-time>` element in the Updated column');
    assert.equal(found[1], AT.toISOString());
    assert.equal(new Date(found[1]).getTime(), AT.getTime());
    assert.equal(found[2], 'Sep 1, 2026 7:17pm UTC');
  }
});

test('the old, unmatchable column shape is gone', () => {
  for (const body of [ready(), errored()]) {
    assert.ok(!body.includes('| Name | Status |'), 'the pre-Vercel header is back');
    assert.ok(!body.includes('Visit Preview'), '`Visit Preview` is not an anchor scrapers match');
  }
});

test('Vercel\'s signed `[vc]:` metadata line is never forged', () => {
  for (const body of [ready(), errored()]) {
    assert.ok(!body.includes('[vc]:'), 'we must not emit a fake Vercel metadata payload');
  }
});

// ── The marker: this repo's own contract with the "Decide" step ───────────────

test('a successful comment records the full SHA the Decide step reads back', () => {
  const body = ready();
  assert.ok(body.startsWith(`${WEB_PREVIEW_MARKER} sha=${SHA} -->`));
  // The exact regex in web-preview-deploy.yml's Decide step.
  assert.equal(body.match(/lorekit-web-preview sha=([0-9a-f]{40})/)?.[1], SHA);
});

test('a FAILED comment omits `sha=` so the next push re-attempts the deploy', () => {
  const body = errored();
  assert.ok(body.startsWith(`${WEB_PREVIEW_MARKER} -->`));
  assert.equal(body.match(/lorekit-web-preview sha=([0-9a-f]{40})/), null);
  // Still found by the same sticky-comment key, so it edits in place.
  assert.ok(body.includes(WEB_PREVIEW_MARKER));
});

// ── Content that must survive the reshape ────────────────────────────────────

test('the commit, the redeploy hint and the run link stay in the footnote', () => {
  const body = ready();
  assert.ok(body.includes(`[\`${SHA.slice(0, 7)}\`](${COMMIT_URL})`));
  assert.ok(body.includes('`/web-preview`'));
  assert.ok(body.includes(`[Workflow logs](${RUN_URL})`));
});

test('a missing stable alias is announced, not silently identical', () => {
  assert.ok(!ready().includes('stable alias was unavailable'));
  assert.ok(
    ready({ aliasAvailable: false, previewUrl: COMMIT_URL }).includes('stable alias was unavailable'),
  );
});

test('an on-demand deploy says so', () => {
  assert.ok(!ready().includes('Deployed on demand'));
  assert.ok(ready({ forced: true }).includes('Deployed on demand'));
});

test('the failure reason is blockquoted line by line, with a fallback', () => {
  const body = errored({ detail: 'Line one\nLine two' });
  assert.ok(body.includes('> Line one'));
  assert.ok(body.includes('> Line two'));
  assert.ok(body.includes('> [!WARNING]'));
  assert.ok(errored({ detail: '   ' }).includes('did not complete'));
});

test('an Error row offers no preview link', () => {
  assert.equal(errored().match(/\[Preview\]\(/), null);
  assert.ok(errored().includes('![Error](https://vercel.com/static/status/error.svg)'));
});

// ── Guards ───────────────────────────────────────────────────────────────────

test('a short or malformed SHA is refused rather than rendered', () => {
  assert.throws(() => ready({ sha: '4f30775' }), /full 40-char SHA/);
  assert.throws(() => errored({ sha: '' }), /full 40-char SHA/);
  assert.throws(() => ready({ previewUrl: '' }), /required/);
});

test('formatUpdatedLabel spells midnight and noon the way Vercel does', () => {
  assert.equal(formatUpdatedLabel(new Date('2026-01-05T00:04:00Z')), 'Jan 5, 2026 12:04am UTC');
  assert.equal(formatUpdatedLabel(new Date('2026-12-31T12:00:00Z')), 'Dec 31, 2026 12:00pm UTC');
  assert.equal(formatUpdatedLabel(new Date('2026-09-02T10:41:25Z')), 'Sep 2, 2026 10:41am UTC');
});

// ── The workflow consumes THIS module, rather than carrying a copy ───────────
// The whole reason the renderer moved out of the YAML is that the format is now
// a contract with outside tooling; an inline table in the workflow would drift
// away from these assertions silently.
test('web-preview-deploy.yml renders through this module', () => {
  const yaml = readFileSync(join(repoRoot, '.github/workflows/web-preview-deploy.yml'), 'utf8');
  assert.ok(
    yaml.includes('scripts/ci/web-preview-comment.mjs'),
    'the workflow no longer imports the canonical renderer',
  );
  assert.ok(yaml.includes('renderReadyComment'), 'the success comment does not use the renderer');
  assert.ok(yaml.includes('renderErrorComment'), 'the failure comment does not use the renderer');
  assert.ok(
    !yaml.includes('| Project | Deployment | Actions | Updated |'),
    'the table is inlined in the workflow again — it must live in one place',
  );
});
