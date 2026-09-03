// ─────────────────────────────────────────────────────────────────────────────
// Canonical renderer for the sticky "web preview" PR comment.
//
// The body is deliberately shaped like VERCEL's own preview comment, because
// tooling reads it. Anything that scrapes a PR for "where is the preview?" was
// written against Vercel's table — it looks for the `| Project | Deployment |
// Actions | Updated |` header and pulls the URL out of the `[Preview](…)` link
// in the Actions column. Our previous table said `| Name | Status | Preview |
// Deployment (this commit) | Updated (UTC) |` with a `[Visit Preview](…)` cell,
// which is the same information in a shape none of that logic matches — so the
// preview existed and nothing could find it.
//
// What is REPRODUCED from Vercel's format (each line is load-bearing for a
// parser, not decoration):
//   - the four column headers, in order, with Vercel's own alignment row;
//   - a `![Ready](…ready.svg) [Ready](<deployment>)` Deployment cell;
//   - a `[Preview](<url>)` link as the Actions cell — the anchor most scrapers
//     key on, and the reason the columns could not simply be renamed;
//   - a `<relative-time datetime="…">` Updated cell (GitHub renders it live).
//
// What is deliberately NOT reproduced: Vercel's leading `[vc]: #<hash>:<base64>`
// metadata line. That is a signed payload describing real Vercel projects and
// deployment ids; forging one would make our comment lie to anything that
// decodes it (Vercel's own bot included). Our HTML marker below is the identity
// this workflow keys on, and it is kept exactly as it was — the "Decide" step in
// web-preview-deploy.yml reads `sha=<40 hex>` out of it to decide whether a
// redeploy is needed, so the marker's shape is a contract, not a comment.
//
// Consumed by .github/workflows/web-preview-deploy.yml (both the success and the
// failure comment) via a dynamic import from the checkout, and unit-tested by
// web-preview-comment.test.mjs — the format is machine-readable, so it is held
// by assertions rather than by discipline.
// ─────────────────────────────────────────────────────────────────────────────

/** Stable find-key for the sticky comment — matches with and without a `sha=`. */
export const WEB_PREVIEW_MARKER = '<!-- lorekit-web-preview';

/** Vercel's status icons, hotlinked exactly as its own comment does. */
const STATUS_ICON = {
  ready: 'https://vercel.com/static/status/ready.svg',
  error: 'https://vercel.com/static/status/error.svg',
};

/** The project name in the Project column. */
const PROJECT = 'lorekit';

const TABLE_HEADER = [
  '| Project | Deployment | Actions | Updated |',
  '| :--- | :----- | :------ | :------ |',
];

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * The literal text inside `<relative-time>`, in Vercel's phrasing
 * (`Sep 1, 2026 7:17pm UTC`). GitHub replaces it with a live relative string
 * when it renders the element, so this is the fallback anyone sees in a raw
 * body, an email notification, or an API read.
 *
 * @param {Date} at
 * @returns {string}
 */
export function formatUpdatedLabel(at) {
  const hours24 = at.getUTCHours();
  const meridiem = hours24 < 12 ? 'am' : 'pm';
  const hours = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(at.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()} ${hours}:${minutes}${meridiem} UTC`;
}

/**
 * The Updated cell — a GitHub `<relative-time>` element, as Vercel emits.
 *
 * @param {Date} at
 * @returns {string}
 */
function updatedCell(at) {
  return `<relative-time datetime="${at.toISOString()}">${formatUpdatedLabel(at)}</relative-time>`;
}

/**
 * The marker line. A successful deploy records the full head SHA in it; a FAILED
 * one deliberately does not, so the next web push re-attempts the deploy instead
 * of treating the failed commit as already deployed.
 *
 * @param {string | null} sha - full 40-char SHA, or null to omit it.
 * @returns {string}
 */
function markerLine(sha) {
  return sha ? `${WEB_PREVIEW_MARKER} sha=${sha} -->` : `${WEB_PREVIEW_MARKER} -->`;
}

const INTRO = 'The dashboard preview for this PR — redeployed on each push that changes the web app.';

function assertFullSha(sha) {
  if (!/^[0-9a-f]{40}$/.test(String(sha ?? ''))) {
    throw new Error(`web-preview comment: expected a full 40-char SHA, got '${sha}'`);
  }
}

/**
 * The comment for a SUCCESSFUL preview deploy.
 *
 * @param {object} input
 * @param {string} input.sha            Full 40-char SHA of the deployed head.
 * @param {string} input.previewUrl     Stable "latest commit" URL (the `pr-<n>` alias),
 *                                      or the immutable one when aliasing was unavailable.
 * @param {string} input.commitUrl      Immutable per-deployment URL for THIS commit.
 * @param {boolean} input.aliasAvailable Whether the stable alias was set this run.
 * @param {boolean} input.forced        Whether this run came from `/web-preview`.
 * @param {string} input.runUrl         Workflow-run URL.
 * @param {Date} [input.at]             Timestamp for the Updated cell (defaults to now).
 * @returns {string} The full comment body.
 */
export function renderReadyComment({
  sha,
  previewUrl,
  commitUrl,
  aliasAvailable,
  forced,
  runUrl,
  at = new Date(),
}) {
  assertFullSha(sha);
  if (!previewUrl || !commitUrl) {
    throw new Error('web-preview comment: previewUrl and commitUrl are both required');
  }
  const short = sha.slice(0, 7);
  const aliasNote = aliasAvailable
    ? ''
    : ' (the stable alias was unavailable this run, so **Preview** points at this exact build too — see the workflow logs)';
  return [
    markerLine(sha),
    INTRO,
    '',
    ...TABLE_HEADER,
    `| **${PROJECT}** | ![Ready](${STATUS_ICON.ready}) [Ready](${commitUrl}) | [Preview](${previewUrl}) | ${updatedCell(at)} |`,
    '',
    `<sub>**Preview** always points at this PR's latest commit; **Deployment** is the immutable build of [\`${short}\`](${commitUrl})${aliasNote}. · Comment \`/web-preview\` to force a redeploy.${forced ? ' · Deployed on demand.' : ''} · [Workflow logs](${runUrl})</sub>`,
  ].join('\n');
}

/**
 * The comment for a FAILED preview deploy — same table, `Error` status, no
 * preview link, plus the captured reason so a block (most often the commit
 * author's email not matching a GitHub account with project access) is visible
 * on the PR instead of only in a job nobody opens.
 *
 * @param {object} input
 * @param {string} input.sha       Full 40-char SHA of the head that failed.
 * @param {string} input.detail    Captured failure reason (may be multi-line).
 * @param {string} input.runUrl    Workflow-run URL.
 * @param {Date} [input.at]        Timestamp for the Updated cell (defaults to now).
 * @returns {string} The full comment body.
 */
export function renderErrorComment({ sha, detail, runUrl, at = new Date() }) {
  assertFullSha(sha);
  const short = sha.slice(0, 7);
  const reason =
    (detail ?? '').trim() ||
    'The Vercel deployment did not complete. See the workflow logs for the CLI output.';
  return [
    // No `sha=` on purpose — see markerLine().
    markerLine(null),
    INTRO,
    '',
    ...TABLE_HEADER,
    `| **${PROJECT}** | ![Error](${STATUS_ICON.error}) Error | — | ${updatedCell(at)} |`,
    '',
    '> [!WARNING]',
    `> **The preview deploy for \`${short}\` failed — no preview is available.**`,
    '>',
    ...reason.split('\n').map((line) => `> ${line}`),
    '',
    `<sub>A blocked deployment is most often the commit author's email not matching a GitHub account with project access. Fix the cause, then push again or comment \`/web-preview\` to retry. · [Workflow logs](${runUrl})</sub>`,
  ].join('\n');
}
