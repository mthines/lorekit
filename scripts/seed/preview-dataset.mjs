/**
 * The pure half of the preview seed — a deterministic, hand-authored dataset
 * plus the derivation of everything the dashboard reads FROM it (per-memory
 * read/opened/cited counters, `memory_read_daily` day rows, and 30 days of
 * `usage_events`).
 *
 * Deterministic on purpose: every timestamp is computed relative to a `now`
 * passed in by the caller (never `Date.now()` read inside this module), and
 * the one place randomness is needed (jittering an hour-of-day so nothing
 * lands at exact midnight, and spreading counts across days) uses a seeded
 * PRNG — so the SAME `now` always produces the SAME dataset, which is what
 * makes `seed-preview.mjs --dry-run` a meaningful diff and a re-seed close to
 * idempotent (the runner upserts memories by `(user_id, scope, key)`).
 *
 * This module has NO I/O — it returns plain JS objects. `seed-preview.mjs`
 * turns them into SQL and executes it.
 */

/** Tag every seeded row carries, so `--reset` can find exactly its own rows. */
export const SEED_TAG = 'seed::preview';

/**
 * Every seeded memory's `key` is prefixed with this, so it can NEVER collide
 * with a real memory a smoke test or a person wrote under the same account —
 * `(user_id, scope, key)` is the table's only uniqueness constraint, and the
 * seed reuses realistic-looking key names (some borrowed from this repo's own
 * lore) on purpose. The prefix is also what makes the seeded rows trivially
 * findable in the Explorer (search `preview-seed/`) without relying on tags.
 */
export const SEED_KEY_PREFIX = 'preview-seed/';

/** Prefix every seeded usage_events.correlation_id carries, for the same reason. */
export const SEED_CORRELATION_PREFIX = 'preview-seed';

export const SEED_ORG_SLUG = 'preview-seed-org';
export const SEED_ORG_NAME = 'Preview Seed Org';

/** Deterministic (not DB-generated) so memories/read-daily/citations can reference it without a round trip. */
export const SEED_ORG_ID = '00000000-0000-4000-9000-000000000001';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** mulberry32 — tiny deterministic PRNG. Same seed → same sequence, always. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoAt(now, daysAgo, hourJitter = 0) {
  return new Date(now.getTime() - daysAgo * MS_PER_DAY - hourJitter * 60 * 60 * 1000).toISOString();
}

/**
 * The hand-authored lesson set. Every filterable dimension (label/tag, kind,
 * host, agent, trigger, origin repo/branch/pr) is deliberately given several
 * distinct values so the Explorer's filter menu, the scope tree, and the
 * heatmap all read as a lived-in workspace rather than one repeated value.
 *
 * `popularity` drives the derived read/opened/cited counters below — it maps
 * directly onto `/insights`' five utility states (`LESSON_UTILITY_THRESHOLDS`
 * in `@lorekit/schemas`): `load-bearing` and `specialist` clear the pull-through
 * bar, `noise-tax` is read a lot but rarely applied, `dormant` is old and
 * unread, `unproven` is too new/thin to have evidence either way.
 */
const TEMPLATES = [
  // ── global — cross-cutting agent lessons ──────────────────────────────────
  { scope: 'global', key: 'aw-lessons::worktree-isolation', value: 'Always branch a worktree from the stacked PR head, never from main, or the diff double-counts the parent branch.', tags: ['loop::aw-lessons', 'source::stuck-loop'], host: 'aw', agent: 'aw', trigger: 'stuck-loop', kind: 'lesson', ageDays: 4, origin: { repo: 'mthines/lorekit', branch: 'main', pr: 482 }, popularity: 'load-bearing' },
  { scope: 'global', key: 'aw-lessons::npx-over-pnpm-exec', value: 'Run browser-mode Vitest via npx — pnpm exec keeps the Playwright child stdio open and the run never returns.', tags: ['loop::aw-lessons'], host: 'aw', agent: 'aw', trigger: 'tool-failure', kind: 'lesson', ageDays: 9, popularity: 'load-bearing' },
  { scope: 'global', key: 'aw-lessons::no-ai-coauthor', value: 'Never add Co-Authored-By AI tags to commits or PRs in this workflow.', tags: ['loop::aw-lessons'], host: 'aw', agent: 'aw', trigger: 'retrospective', kind: 'lesson', ageDays: 21, popularity: 'load-bearing' },
  { scope: 'global', key: 'aw-lessons::mock-that-reimplements-the-thing-under-test', value: 'A mock (or eval, or contract check) that re-encodes the thing it verifies proves the mock is self-consistent, not that the real thing works.', tags: ['loop::aw-lessons'], host: 'aw', agent: 'aw', trigger: 'retrospective', kind: 'lesson', ageDays: 2, popularity: 'unproven' },
  { scope: 'global', key: 'bash::indirect-var-length-needs-a-temp-var', value: 'Looping over env var NAMES to report length needs a temp var — `${!name}` inside `${#...}` does not expand indirectly in bash.', tags: ['bash', 'gotcha'], host: 'aw', agent: 'claude', trigger: 'tool-failure', kind: 'signal', ageDays: 33, popularity: 'specialist' },
  { scope: 'global', key: 'claude-cli::bypasspermissions-refused-under-root', value: 'Spawning a nested `claude -p` from inside a container running as root under --dangerously-skip-permissions gives an empty transcript, not an error — check the exit code, not just stdout.', tags: ['claude-cli', 'gotcha'], host: 'aw', agent: 'claude', trigger: 'tool-failure', kind: 'signal', ageDays: 58, popularity: 'dormant' },
  { scope: 'global', key: 'github-mcp::get_job_logs-needs-job_id', value: 'Reading a successful job\'s log needs the numeric job_id — failed_only=true skips green jobs entirely and returns nothing.', tags: ['github', 'mcp'], host: 'ci-auto-fix', agent: 'claude', trigger: 'tool-failure', kind: 'signal', ageDays: 12, popularity: 'specialist' },
  { scope: 'global', key: 'reviewer-lessons::gh-api-raw-field-stringifies-comments', value: '`gh api --raw-field` stringifies the comments array, so a review POST carrying inline comments 422s — use --input with a JSON file instead.', tags: ['loop::reviewer-lessons', 'github'], host: 'reviewer', agent: 'claude', trigger: 'tool-failure', kind: 'lesson', ageDays: 40, popularity: 'load-bearing' },
  { scope: 'global', key: 'release-notes-ground-a-docs-page-in-code-not-issue-titles', value: 'A release-notes docs page must be grounded in the actual diff, not issue titles — a title promises a feature the code shipped differently or not at all.', tags: ['docs', 'loop::aw-lessons'], host: 'aw', agent: 'aw', trigger: 'review-comment', kind: 'lesson', ageDays: 66, popularity: 'noise-tax' },
  { scope: 'global', key: 'aw-tester-lessons::playwright-cli-ignores-dot-directories', value: '`playwright test <path>` silently finds 0 tests when the path lives under a dot-directory — move specs out of `.claude/` or pass --config explicitly.', tags: ['loop::aw-tester-lessons', 'playwright'], host: 'aw', agent: 'aw', trigger: 'tool-failure', kind: 'signal', ageDays: 15, popularity: 'specialist' },
  { scope: 'global', key: 'linear-mcp-list_milestones-uses-project-not-projectid', value: 'The Linear MCP list_milestones tool takes a single param named `project` (project name or id) — `projectId` is silently ignored, not rejected.', tags: ['linear', 'mcp'], host: 'aw', agent: 'claude', trigger: 'tool-failure', kind: 'signal', ageDays: 27, popularity: 'unproven' },
  { scope: 'global', key: 'implement-suggestion-lessons::unpushable-premise-needs-reverification', value: 'An inherited lesson claiming a fix was unpushable must be re-verified against the CURRENT push history before reuse — the blocker it recorded may already be gone.', tags: ['loop::implement-suggestion-lessons'], host: 'aw', agent: 'aw', trigger: 'retrospective', kind: 'lesson', ageDays: 3, popularity: 'unproven' },

  // ── repo::mthines/lorekit — this repo's own architecture lessons ─────────
  { scope: 'repo::mthines/lorekit', key: 'edge-parity::mirror-pattern', value: 'Pure logic that both mcp-core and the Deno edge need lives once in mcp-core and is mirrored self-contained; a drift spec guards the copy.', tags: ['architecture'], host: 'aw', agent: 'claude', trigger: 'retrospective', kind: 'lesson', ageDays: 26, origin: { repo: 'mthines/lorekit', branch: 'main' }, popularity: 'load-bearing' },
  { scope: 'repo::mthines/lorekit', key: 'scope-format::double-colon', value: 'The canonical scope separator is :: — a single colon is a 400. All segments lowercased.', tags: ['scope', 'validation'], host: 'aw', agent: 'claude', trigger: 'manual', kind: 'lesson', ageDays: 50, popularity: 'load-bearing' },
  { scope: 'repo::mthines/lorekit', key: 'audit::one-vocabulary', value: 'AUDIT_ACTIONS is the single list; the SQL CHECK, the web copy, and the edge mirror are all asserted equal by a drift spec.', tags: ['audit', 'loop::reviewer-comment-relevance'], host: 'reviewer', agent: 'claude', trigger: 'review-comment', kind: 'lesson', ageDays: 74, origin: { repo: 'mthines/lorekit', branch: 'main', pr: 311 }, popularity: 'specialist' },
  { scope: 'repo::mthines/lorekit', key: 'rls::service-role-user-filter', value: 'api_key auth uses the service-role client — every query MUST .eq(user_id, userId) or it leaks across tenants.', tags: ['security', 'rls', 'loop::review-outcomes'], host: 'reviewer', agent: 'cursor', trigger: 'review-comment', kind: 'lesson', ageDays: 98, popularity: 'load-bearing' },
  { scope: 'repo::mthines/lorekit', key: 'otel::one-service-name', value: 'All five edge functions are one service "api"; tell them apart with faas.name, never a per-function SERVICE_NAME secret.', tags: ['otel'], host: 'aw', agent: 'claude', trigger: 'manual', kind: 'lesson', ageDays: 15, popularity: 'specialist' },
  { scope: 'repo::mthines/lorekit', key: 'edge-cors-www-apex-domain-mismatch', value: 'Dashboard CORS root cause: the canonical Vercel domain and the apex domain must both be in the allow-list, not just one of them.', tags: ['cors', 'bug'], host: 'ci-auto-fix', agent: 'claude', trigger: 'pr-webhook', kind: 'bus', ageDays: 88, origin: { repo: 'mthines/lorekit', branch: 'main', pr: 330 }, popularity: 'dormant' },
  { scope: 'repo::mthines/lorekit', key: 'perl-sed-inplace-corrupts-utf8-emdashes', value: 'Batch-editing a source file with perl -pi or sed -i on macOS corrupts UTF-8 em-dashes — use Node\'s fs.readFileSync/writeFileSync for a text rewrite instead.', tags: ['gotcha', 'tooling'], host: 'aw', agent: 'claude', trigger: 'tool-failure', kind: 'signal', ageDays: 44, popularity: 'noise-tax' },
  { scope: 'repo::mthines/lorekit', key: 'ci-auto-fix-lessons::vercel-preview-daily-quota', value: '"Web — Vercel preview" red on an account-level 24h quota is never a repo failure — check the Vercel dashboard quota banner before diagnosing the workflow.', tags: ['loop::ci-auto-fix-lessons', 'ci'], host: 'ci-auto-fix', agent: 'claude', trigger: 'pr-webhook', kind: 'signal', ageDays: 19, popularity: 'specialist' },
  { scope: 'repo::mthines/lorekit', key: 'linear-workspace-mapping-for-lorekit-tasks', value: 'LoreKit issues go to the `lorekit` Linear workspace (linear.app/lorekit), team LOR — do not file them under the personal workspace.', tags: ['linear', 'process'], host: 'aw', agent: 'claude', trigger: 'manual', kind: 'signal', ageDays: 71, popularity: 'dormant' },
  { scope: 'repo::mthines/lorekit', key: 'command-coverage::settings-nav-shortcuts', value: 'The six Settings subsections each need their own keyboard shortcut entry in command-coverage — a shared parent shortcut silently drops the children.', tags: ['ux', 'settings'], host: 'aw', agent: 'claude', trigger: 'review-comment', kind: 'lesson', ageDays: 6, popularity: 'unproven' },
  { scope: 'repo::mthines/lorekit', key: 'nx-affected-never-run-many-all-in-sandbox', value: '`pnpm nx run-many -t … --all` saturates a cloud sandbox — every project starts at once and the session stalls. Use `nx affected` instead.', tags: ['nx', 'ci', 'sandbox'], host: 'aw', agent: 'claude', trigger: 'stuck-loop', kind: 'signal', ageDays: 1, popularity: 'unproven' },
  { scope: 'repo::mthines/lorekit', key: 'deno-check-needs-node-modules-dir-none', value: '`deno check` must pass --node-modules-dir=none or npm: specifiers resolve from the repo\'s pnpm node_modules instead of Deno\'s own cache, hiding real edge-only errors.', tags: ['deno', 'edge'], host: 'aw', agent: 'codex', trigger: 'tool-failure', kind: 'signal', ageDays: 37, popularity: 'noise-tax' },
  { scope: 'repo::mthines/lorekit', key: 'node-fetch-ignores-https-proxy', value: 'Node\'s built-in fetch ignores HTTPS_PROXY — telemetry exports 403 "host not in allowlist" even for an allowed host unless NODE_USE_ENV_PROXY=1 is set.', tags: ['telemetry', 'gotcha'], host: 'aw', agent: 'claude', trigger: 'tool-failure', kind: 'signal', ageDays: 24, popularity: 'specialist' },

  // ── repo::mthines/gw-tools — the sibling repo, for cross-repo filtering ───
  { scope: 'repo::mthines/gw-tools', key: 'nx-version-must-match-lorekit-exactly', value: 'NX 22.4.0 matches lorekit exactly — bump both repos together or the shared generators drift.', tags: ['nx', 'process'], host: 'aw', agent: 'claude', trigger: 'manual', kind: 'signal', ageDays: 60, origin: { repo: 'mthines/gw-tools', branch: 'main' }, popularity: 'dormant' },
  { scope: 'repo::mthines/gw-tools', key: 'flaky-e2e-retry-budget-is-two-not-three', value: 'The e2e runner\'s retry budget is 2, not the Playwright default of 3 — a third retry silently never happens and a genuinely flaky test looks fixed.', tags: ['e2e', 'flake'], host: 'aw', agent: 'claude', trigger: 'stuck-loop', kind: 'lesson', ageDays: 8, origin: { repo: 'mthines/gw-tools', branch: 'fix/flaky-e2e', pr: 578 }, popularity: 'specialist' },
  { scope: 'repo::mthines/gw-tools', key: 'gw-tools-shares-lorekit-eslint-config', value: 'gw-tools imports its ESLint config from lorekit\'s root package rather than vendoring its own — do not fork it locally.', tags: ['tooling'], host: 'aw', agent: 'claude', trigger: 'manual', kind: 'signal', ageDays: 95, origin: { repo: 'mthines/gw-tools', branch: 'main' }, popularity: 'dormant' },

  // ── project::agent-skills — the shared skills repo ────────────────────────
  { scope: 'project::agent-skills', key: 'routing::tier-detection', value: 'When in doubt, route Full — an over-planned Micro wastes compute, but an under-planned architectural task ships wrong code.', tags: ['aw', 'routing'], host: 'aw', agent: 'aw', trigger: 'retrospective', kind: 'lesson', ageDays: 10, origin: { repo: 'mthines/agent-skills', branch: 'main' }, popularity: 'load-bearing' },
  { scope: 'project::agent-skills', key: 'confidence::plan-gate', value: 'A failed deterministic rule caps the confidence gate at 89% regardless of the LLM score.', tags: ['aw', 'confidence'], host: 'aw', agent: 'aw', trigger: 'retrospective', kind: 'lesson', ageDays: 12, origin: { repo: 'mthines/agent-skills', branch: 'main' }, popularity: 'load-bearing' },
  { scope: 'project::agent-skills', key: 'intake-use-memory-search-not-list', value: 'The intake step should call memory.search with the tag filter, not memory.list — list pages by recency and can miss an older matching lesson.', tags: ['aw', 'loop::aw-lessons'], host: 'aw', agent: 'aw', trigger: 'retrospective', kind: 'signal', ageDays: 5, popularity: 'unproven' },
  { scope: 'project::agent-skills', key: 'critical-skill-caps-one-pass-per-run', value: 'The /critical skill is deliberately one adversarial pass per run — a naive self-refine loop amplifies the same bias instead of catching it.', tags: ['critical', 'process'], host: 'aw', agent: 'aw', trigger: 'manual', kind: 'signal', ageDays: 41, origin: { repo: 'mthines/agent-skills', branch: 'main' }, popularity: 'noise-tax' },
  { scope: 'project::agent-skills', key: 'ideate-persona-count-caps-at-six', value: 'Nominal-group persona generation caps at six personas — beyond that, novelty scores stop separating and the round just costs more tokens.', tags: ['ideate'], host: 'aw', agent: 'aw', trigger: 'retrospective', kind: 'signal', ageDays: 30, origin: { repo: 'mthines/agent-skills', branch: 'main' }, popularity: 'dormant' },

  // ── branch::mthines/lorekit::feat/storybook — branch-scoped, short-lived ─
  { scope: 'branch::mthines/lorekit::feat/storybook', key: 'msw::wildcard-origin', value: 'Match the edge function with a */functions/v1 wildcard so the handler survives an unset NEXT_PUBLIC_SUPABASE_URL.', tags: ['storybook', 'msw'], host: 'aw', agent: 'claude', trigger: 'tool-failure', kind: 'lesson', ageDays: 120, origin: { repo: 'mthines/lorekit', branch: 'feat/storybook', pr: 311 }, popularity: 'dormant' },
  { scope: 'branch::mthines/lorekit::feat/storybook', key: 'snapshot::freeze-the-clock', value: 'Freeze Date before rendering any time-relative UI, or "3d ago" and trend chips flake the baseline overnight.', tags: ['storybook', 'flake'], host: 'aw', agent: 'claude', trigger: 'tool-failure', kind: 'lesson', ageDays: 126, origin: { repo: 'mthines/lorekit', branch: 'feat/storybook' }, popularity: 'dormant' },
  { scope: 'branch::mthines/lorekit::feat/storybook', key: 'vitest-browser-mode-needs-npx', value: 'Invoke the Storybook Vitest suite with npx, not pnpm exec or nx run — those wrap the process and keep the Playwright browser child\'s stdio open.', tags: ['storybook', 'vitest'], host: 'aw', agent: 'claude', trigger: 'stuck-loop', kind: 'signal', ageDays: 119, origin: { repo: 'mthines/lorekit', branch: 'feat/storybook' }, popularity: 'dormant' },

  // ── branch::mthines/lorekit::feat/otel-rollup — a more recent branch ─────
  { scope: 'branch::mthines/lorekit::feat/otel-rollup', key: 'self-time-merge-not-sum', value: 'lorekit.io.wait_ms merges overlapping outbound-call intervals — summing them double-counts concurrent queries and can drive self_time negative.', tags: ['otel'], host: 'aw', agent: 'claude', trigger: 'review-comment', kind: 'lesson', ageDays: 7, origin: { repo: 'mthines/lorekit', branch: 'feat/otel-rollup', pr: 501 }, popularity: 'specialist' },
  { scope: 'branch::mthines/lorekit::feat/otel-rollup', key: 'span-kind-client-marks-outbound', value: 'Any child span with kind CLIENT counts as an outbound call for the self-time split — a same-process helper span must not carry that kind.', tags: ['otel'], host: 'aw', agent: 'claude', trigger: 'tool-failure', kind: 'signal', ageDays: 6, origin: { repo: 'mthines/lorekit', branch: 'feat/otel-rollup', pr: 501 }, popularity: 'unproven' },

  // ── branch::mthines/gw-tools::fix/flaky-e2e ───────────────────────────────
  { scope: 'branch::mthines/gw-tools::fix/flaky-e2e', key: 'playwright-trace-viewer-needs-retain-on-failure', value: 'Set trace: "retain-on-failure" in the Playwright config, not "on" — "on" keeps a trace for every green run too and blows the CI artifact quota.', tags: ['playwright', 'ci'], host: 'aw', agent: 'claude', trigger: 'tool-failure', kind: 'signal', ageDays: 8, origin: { repo: 'mthines/gw-tools', branch: 'fix/flaky-e2e', pr: 578 }, popularity: 'unproven' },
];

/**
 * How each `popularity` bucket resolves into the counters the dashboard
 * derives value from — kept in one place so the numbers agree with each
 * other (a "load-bearing" lesson must clear BOTH the pull-through bar and the
 * broad-delivery bar `LESSON_UTILITY_THRESHOLDS` in `@lorekit/schemas` sets).
 */
const POPULARITY_PROFILES = {
  'load-bearing': { deliveries: 340, pullThrough: 0.22, citationShare: 0.6 },
  specialist: { deliveries: 40, pullThrough: 0.35, citationShare: 0.4 },
  'noise-tax': { deliveries: 260, pullThrough: 0.01, citationShare: 0 },
  dormant: { deliveries: 6, pullThrough: 0, citationShare: 0 },
  unproven: { deliveries: 8, pullThrough: 0.1, citationShare: 0.1 },
};

function scopeType(scope) {
  if (scope === 'global') return 'global';
  if (scope.startsWith('project::')) return 'project';
  if (scope.startsWith('branch::')) return 'branch';
  return 'repo';
}

/** Spread `count` targeted+bulk reads across the days since a memory was created. */
function buildReadDailyForMemory(memoryId, ageDays, deliveries, rand, now) {
  if (deliveries <= 0) return [];
  const span = Math.max(1, Math.min(ageDays, 30));
  const rows = [];
  let remaining = deliveries;
  for (let d = 0; d < span && remaining > 0; d++) {
    // Recent days carry more traffic than the tail — a lived-in heatmap, not
    // a flat one.
    const weight = 1 - d / span;
    const dayCount = Math.max(0, Math.round(deliveries * weight * (0.15 + 0.15 * rand())));
    if (dayCount === 0) continue;
    const bulk = Math.round(dayCount * 0.7);
    const targeted = dayCount - bulk;
    const day = new Date(now.getTime() - d * MS_PER_DAY).toISOString().slice(0, 10);
    if (bulk > 0) rows.push({ memory_id: memoryId, day, read_kind: 'bulk', count: bulk });
    if (targeted > 0) rows.push({ memory_id: memoryId, day, read_kind: 'targeted', count: targeted });
    remaining -= dayCount;
  }
  return rows;
}

/**
 * Build the full seed dataset relative to `now`.
 *
 * @param {{ now?: Date, days?: number }} opts `days` bounds the usage_events
 *   window (default 30, matching /insights' widest bounded range).
 */
export function buildDataset({ now = new Date(), days = 30 } = {}) {
  const rand = mulberry32(42);
  const org = { id: SEED_ORG_ID, slug: SEED_ORG_SLUG, name: SEED_ORG_NAME };

  const memories = [];
  const readDaily = [];
  const citations = [];

  TEMPLATES.forEach((t, i) => {
    const hourJitter = rand() * 20;
    const createdAt = isoAt(now, t.ageDays, hourJitter);
    const isArchived = t.popularity === 'dormant' && i % 5 === 0;
    // A couple of already-expired rows (past ttl_days) and a couple of
    // active ones (future expiry) — `purge-expired`, the expired stat, and
    // the groom candidates view all need at least one of each to be
    // non-empty in a demo.
    const isExpired = t.trigger === 'pr-webhook' && t.ageDays > 60;
    const hasActiveTtl = t.kind === 'signal' && t.ageDays < 10;
    const isProtected = t.popularity === 'load-bearing' && i % 4 === 0;
    // Org-owns roughly a sixth of the repo-scoped lore, so the owner facet and
    // the org Settings page both have real rows to show.
    const orgOwned = t.scope.startsWith('repo::') && i % 6 === 0;

    const profile = POPULARITY_PROFILES[t.popularity];
    const deliveries = Math.round(profile.deliveries * (0.7 + 0.6 * rand()));
    const opened = Math.round(deliveries * profile.pullThrough);
    const cited = Math.round(opened * profile.citationShare);

    const memory = {
      // A stable, content-derived id (not random) so re-running the dataset
      // builder for a diff/dry-run always names the same row.
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      scope: t.scope,
      scopeType: scopeType(t.scope),
      key: `${SEED_KEY_PREFIX}${t.key}`,
      value: t.value,
      tags: [...t.tags, SEED_TAG],
      source_agent: t.agent,
      trigger: t.trigger,
      kind: t.kind,
      host: t.host,
      created_at: createdAt,
      updated_at: createdAt,
      archived_at: isArchived ? isoAt(now, Math.max(1, t.ageDays - 2), hourJitter) : null,
      // `isoAt` subtracts days, so a NEGATIVE offset lands in the future.
      expires_at: isExpired ? isoAt(now, 5, 0) : hasActiveTtl ? isoAt(now, -14, 0) : null,
      protected: isProtected,
      origin_repo: t.origin?.repo ?? null,
      origin_branch: t.origin?.branch ?? null,
      origin_commit: t.origin?.repo ? `${(i + 1).toString(16).padStart(7, '0')}${'a1b2c3d'}`.slice(0, 12) : null,
      origin_pr: t.origin?.pr ?? null,
      org_id: orgOwned ? org.id : null,
      read_count: deliveries,
      opened_count: opened,
      last_read_at: deliveries > 0 ? isoAt(now, rand() * Math.min(3, t.ageDays)) : null,
      last_opened_at: opened > 0 ? isoAt(now, rand() * Math.min(5, t.ageDays)) : null,
      cited_count: cited,
      last_cited_at: cited > 0 ? isoAt(now, rand() * Math.min(7, t.ageDays)) : null,
    };
    memories.push(memory);

    for (const row of buildReadDailyForMemory(memory.id, t.ageDays, deliveries, rand, now)) {
      readDaily.push(row);
    }
    for (let c = 0; c < cited; c++) {
      citations.push({
        cited_memory_id: memory.id,
        correlation_id: `${SEED_CORRELATION_PREFIX}-run-${(i * 7 + c) % 40}`,
        created_at: isoAt(now, rand() * Math.min(20, t.ageDays)),
      });
    }
  });

  const usageEvents = buildUsageEvents({ now, days, memories, rand });

  return { org, memories, readDaily, citations, usageEvents };
}

const TOOLS_READ = ['memory.list', 'memory.search', 'memory.read', 'memory.scopes'];
const CLIENTS = ['cli', 'mcp', 'web', 'dashboard'];
const OUTCOMES_WEIGHTED = [
  ['ok', 92],
  ['rate_limited', 3],
  ['cap_exceeded', 1],
  ['permission_denied', 1],
  ['error', 3],
];
const SESSION_KINDS = ['pr', 'ci', 'local', 'unknown'];

function weightedPick(rand, pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r <= 0) return v;
  }
  return pairs[0][0];
}

/**
 * ~30 days of tool-call events. Reads dominate (5:1 over writes), matching
 * how agents actually use lore (`DEFAULT_MIX` in the load test), spread with
 * more traffic on recent days so the Insights trend chips have a real
 * week-over-week signal, and grouped into runs via `correlation_id` so the
 * Runs list is non-empty.
 */
function buildUsageEvents({ now, days, memories, rand }) {
  const events = [];
  const scopes = [...new Set(memories.map((m) => m.scope))];
  let runCounter = 0;
  for (let d = 0; d < days; d++) {
    const dayWeight = 1 - (d / days) * 0.6;
    const callsToday = Math.round((14 + rand() * 10) * dayWeight);
    for (let c = 0; c < callsToday; c++) {
      const isWrite = rand() < 0.17;
      const toolName = isWrite ? 'memory.write' : TOOLS_READ[Math.floor(rand() * TOOLS_READ.length)];
      const scope = scopes[Math.floor(rand() * scopes.length)];
      const outcome = weightedPick(rand, OUTCOMES_WEIGHTED);
      const client = CLIENTS[Math.floor(rand() * CLIENTS.length)];
      const hourJitter = rand() * 22;
      if (c % 6 === 0) runCounter++;
      events.push({
        tool_name: toolName,
        scope_type: scopeType(scope),
        scope,
        scope_count: 1,
        auth_type: client === 'web' || client === 'dashboard' ? 'jwt' : 'api_key',
        outcome,
        duration_ms: Math.round(40 + rand() * 260),
        memory_count: isWrite ? Math.round(50 + rand() * 20) : null,
        result_count: !isWrite && outcome === 'ok' ? Math.round(rand() * 12) : null,
        correlation_id: `${SEED_CORRELATION_PREFIX}-run-${runCounter % 40}`,
        client,
        kind: rand() < 0.4 ? 'lesson' : null,
        host: rand() < 0.3 ? 'aw' : null,
        session_kind: SESSION_KINDS[Math.floor(rand() * SESSION_KINDS.length)],
        created_at: isoAt(now, d, hourJitter),
      });
    }
  }
  return events;
}
