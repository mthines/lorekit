/**
 * MSW fixtures + handlers for the LoreKit REST endpoints the dashboard's React
 * Query hooks call.
 *
 * These back the full-page / full-view visual-regression stories. The hooks
 * (`useScopeTree`, `useTagCatalog`, `useLoreData`, `useDashboardData`, and the
 * `listMemories` server action, which — with `next/headers` auto-mocked by
 * `@storybook/nextjs-vite` — executes in the browser) all talk to the
 * `memories` edge function now rather than to PostgREST directly, so the
 * handlers below mock `…/functions/v1/memories*`.
 *
 * ONE fixture set drives every consumer: `MEMORY_ROWS` is the "database", and
 * each handler derives its own response from it exactly as the real endpoint
 * derives it from Postgres (the list pages, `/scopes` counts per scope,
 * `/tags` counts per label, `/activity` buckets per UTC hour or day). A fixture
 * added to the list therefore shows up in the tree, the label bar and the
 * heatmap without any second place to update.
 *
 * ## Determinism
 * `created_at` values are fixed offsets *before* {@link FROZEN_NOW}. Combined
 * with the `withFrozenClock` story decorator (which pins `Date` to
 * `FROZEN_NOW`), every time-relative render — the "Nd ago" freshness labels, the
 * period-over-period trend chips, the 26-week contribution heatmap — is stable
 * across runs. Never introduce a live `Date.now()` offset here: that is the
 * classic visual-regression flake source this module deliberately avoids.
 */
import { http, HttpResponse } from 'msw';

/**
 * The instant the story clock is frozen to. Fixtures below are dated relative to
 * it; `withFrozenClock(FROZEN_NOW)` pins the renderer to the same instant.
 */
export const FROZEN_NOW = '2026-06-15T12:00:00.000Z';

const FROZEN_MS = new Date(FROZEN_NOW).getTime();
const HOUR = 3_600_000;

/** ISO timestamp a fixed number of hours before the frozen now. */
function hoursAgo(h: number): string {
  return new Date(FROZEN_MS - h * HOUR).toISOString();
}

/** A single fully-shaped memory as `GET /memories` returns it. */
export interface MemoryRow {
  id: string;
  scope: string;
  key: string;
  value: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  expires_at: string | null;
  source_agent: string | null;
  trigger: string | null;
  org_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  /** Resolved owner — null for personal lore (`shapeMemoryRow`). */
  org: { id: string; name: string; slug: string } | null;
  /** Provenance (migration 00048) — where the memory was recorded FROM. */
  origin_repo: string | null;
  origin_branch: string | null;
  origin_commit: string | null;
  origin_pr: number | null;
}

/** The origin half of a fixture row. Every field independently optional. */
type OriginFixture = Partial<
  Pick<MemoryRow, 'origin_repo' | 'origin_branch' | 'origin_commit' | 'origin_pr'>
>;

function row(
  id: string,
  scope: string,
  key: string,
  value: string,
  tags: string[],
  hAgo: number,
  source_agent: string | null,
  origin: OriginFixture = {},
): MemoryRow {
  const created = hoursAgo(hAgo);
  return {
    id,
    scope,
    key,
    value,
    tags,
    created_at: created,
    updated_at: created,
    archived_at: null,
    expires_at: null,
    source_agent,
    trigger: null,
    org_id: null,
    created_by: null,
    updated_by: null,
    org: null,
    origin_repo: origin.origin_repo ?? null,
    origin_branch: origin.origin_branch ?? null,
    origin_commit: origin.origin_commit ?? null,
    origin_pr: origin.origin_pr ?? null,
  };
}

/**
 * A realistic spread of lore across every scope type (global, repo, branch,
 * project) and a range of ages, so the scope tree, heatmap, stat cards, and
 * lesson list all read as a lived-in workspace.
 */
export const MEMORY_ROWS: MemoryRow[] = [
  row('m01', 'global', 'aw-lessons::worktree-isolation', 'Always branch a worktree from the stacked PR head, never from main, or the diff double-counts the parent branch.', ['loop::aw-lessons', 'source::stuck-loop'], 3, 'aw', { origin_repo: 'mthines/lorekit', origin_branch: 'feat/Origin-Provenance', origin_commit: 'a1b2c3d4e5f60718', origin_pr: 482 }),
  row('m02', 'global', 'aw-lessons::npx-over-pnpm-exec', 'Run browser-mode Vitest via npx — pnpm exec keeps the Playwright child stdio open and the run never returns.', ['loop::aw-lessons'], 30, 'aw'),
  row('m03', 'repo::mthines/lorekit', 'edge-parity::mirror-pattern', 'Pure logic that both mcp-core and the Deno edge need lives once in mcp-core and is mirrored self-contained; a spec guards drift.', ['architecture'], 26, 'claude', { origin_repo: 'mthines/lorekit', origin_branch: 'main' }),
  row('m04', 'repo::mthines/lorekit', 'scope-format::double-colon', 'The canonical scope separator is :: — a single colon is a 400. All segments lowercased.', ['scope', 'validation'], 50, 'claude'),
  row('m05', 'repo::mthines/lorekit', 'audit::one-vocabulary', 'AUDIT_ACTIONS is the single list; the SQL CHECK, the web copy, and the edge mirror are all asserted equal by a drift spec.', ['audit'], 74, 'claude'),
  row('m06', 'repo::mthines/lorekit', 'rls::service-role-user-filter', 'api_key auth uses the service-role client — every query MUST .eq(user_id, userId) or it leaks across tenants.', ['security', 'rls'], 98, 'claude'),
  row('m07', 'branch::mthines/lorekit::feat/storybook', 'msw::wildcard-origin', 'Match the edge function with a */functions/v1 wildcard so the handler survives an unset NEXT_PUBLIC_SUPABASE_URL.', ['storybook', 'msw'], 5 * 24, 'claude', { origin_repo: 'mthines/lorekit', origin_branch: 'feat/storybook', origin_pr: 311 }),
  row('m08', 'branch::mthines/lorekit::feat/storybook', 'snapshot::freeze-the-clock', 'Freeze Date before rendering any time-relative UI, or "3d ago" and trend chips flake the baseline overnight.', ['storybook', 'flake'], 5 * 24 + 6, 'claude'),
  row('m09', 'project::agent-skills', 'routing::tier-detection', 'When in doubt, route Full — an over-planned Micro wastes compute, but an under-planned architectural task ships wrong code.', ['aw', 'routing'], 10 * 24, 'aw'),
  row('m10', 'project::agent-skills', 'confidence::plan-gate', 'A failed deterministic rule caps the confidence gate at 89% regardless of the LLM score.', ['aw', 'confidence'], 12 * 24, 'aw'),
  row('m11', 'repo::mthines/lorekit', 'otel::one-service-name', 'All five edge functions are one service "api"; tell them apart with faas.name, never a per-function SERVICE_NAME secret.', ['otel'], 15 * 24, 'claude'),
  row('m12', 'global', 'aw-lessons::no-ai-coauthor', 'Never add Co-Authored-By AI tags to commits or PRs in this workflow.', ['loop::aw-lessons'], 20 * 24, 'aw'),
];

/**
 * A minimal Supabase auth user, returned for `GET|POST /auth/v1/user`. supabase-js
 * only calls this endpoint when a session token is present, so it is a no-op for
 * the browser-client hooks; it is here so any authenticated read path that does
 * reach it resolves to a stable identity rather than an error.
 */
export const AUTH_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'storybook@lorekit.io',
  user_metadata: { user_name: 'storybook' },
  app_metadata: { provider: 'email' },
  created_at: FROZEN_NOW,
};

// ── Response derivation — mirrors what each endpoint does in Postgres ─────────

function activeRows(rows: MemoryRow[], archived: boolean): MemoryRow[] {
  return rows.filter((r) => (archived ? r.archived_at !== null : r.archived_at === null));
}

/** `GET /memories/scopes` — one row per scope, sorted by scope. */
function scopesFrom(rows: MemoryRow[]) {
  const byScope = new Map<string, { count: number; last: string }>();
  for (const r of activeRows(rows, false)) {
    const prev = byScope.get(r.scope);
    if (!prev) byScope.set(r.scope, { count: 1, last: r.created_at });
    else byScope.set(r.scope, { count: prev.count + 1, last: r.created_at > prev.last ? r.created_at : prev.last });
  }
  return Array.from(byScope.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, { count, last }]) => ({ scope, count, last_activity: last }));
}

/** `GET /memories/tags` — one row per label, count desc then label asc. */
function tagsFrom(rows: MemoryRow[], archived: boolean) {
  const counts = new Map<string, number>();
  for (const r of activeRows(rows, archived)) {
    for (const tag of r.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** `GET /memories/activity` — `(bucket, scope)` cells, UTC-anchored. */
function activityFrom(rows: MemoryRow[], unit: 'hour' | 'day') {
  const cells = new Map<string, { bucket: string; scope: string; count: number }>();
  for (const r of activeRows(rows, false)) {
    const bucket = unit === 'hour'
      ? `${r.created_at.slice(0, 13)}:00:00.000Z`
      : `${r.created_at.slice(0, 10)}T00:00:00.000Z`;
    const cellKey = `${bucket}|${r.scope}`;
    const prev = cells.get(cellKey);
    if (prev) prev.count += 1;
    else cells.set(cellKey, { bucket, scope: r.scope, count: 1 });
  }
  return Array.from(cells.values()).sort(
    (a, b) => a.bucket.localeCompare(b.bucket) || a.scope.localeCompare(b.scope),
  );
}

/**
 * `GET /memories` — the filters the dashboard actually sends.
 *
 * This is a REIMPLEMENTATION, and it proves nothing about the handler: `q` here
 * is a lowercased substring over `key + value`, where the real path is
 * `likeNeedle` → `ilikeClause` → PostgREST, and `tags` here is
 * `Array.includes`, where the real path is `parseTagsParam` → `pgArrayLiteral`
 * → `contains`/`overlaps`. A green story therefore says the COMPONENTS behave,
 * never that the filter does — `handleList` threw on every `?tags=` request for
 * a whole commit with this suite passing.
 *
 * The filters themselves are covered against a live stack in
 * `packages/mcp-server/src/memories-api.integration.spec.ts` → "list filters".
 * Keep the semantics here roughly faithful so stories stay realistic, but never
 * treat this as the check.
 */
function listFrom(rows: MemoryRow[], url: URL) {
  const scope = url.searchParams.get('scope');
  const key = url.searchParams.get('key');
  const q = url.searchParams.get('q')?.toLowerCase();
  const tags = url.searchParams.get('tags')?.split(',').filter(Boolean) ?? [];
  const tagsMode = url.searchParams.get('tags_mode') ?? 'any';
  const limit = Number(url.searchParams.get('limit') ?? 50);

  const matched = activeRows(rows, url.searchParams.get('archived') === 'true')
    .filter((r) => (scope ? r.scope === scope : true))
    .filter((r) => (key ? r.key === key : true))
    .filter((r) => (q ? `${r.key} ${r.value}`.toLowerCase().includes(q) : true))
    .filter((r) => (tags.length === 0
      ? true
      : tagsMode === 'all'
        ? tags.every((t) => r.tags.includes(t))
        : tags.some((t) => r.tags.includes(t))))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  // No cursor emulation: every story fits in one page, and a fake cursor would
  // encode a pagination contract the fixtures do not actually implement.
  return { entries: matched.slice(0, limit), hasMore: false, nextCursor: null };
}

/**
 * Handlers that mock every LoreKit REST endpoint the lore/dashboard hooks touch,
 * plus the Supabase auth user read. Origin is wild-carded so a story renders
 * identically whether or not `NEXT_PUBLIC_SUPABASE_URL` was injected into the
 * build.
 *
 * @param rows override the default fixture set (e.g. to story an empty state).
 */
export function memoryHandlers(rows: MemoryRow[] = MEMORY_ROWS) {
  return [
    http.get('*/functions/v1/memories/scopes', () => HttpResponse.json({ scopes: scopesFrom(rows) })),
    http.get('*/functions/v1/memories/tags', ({ request }) =>
      HttpResponse.json({
        tags: tagsFrom(rows, new URL(request.url).searchParams.get('archived') === 'true'),
      })),
    http.get('*/functions/v1/memories/activity', ({ request }) => {
      const url = new URL(request.url);
      const bucket = url.searchParams.get('bucket') === 'hour' ? 'hour' : 'day';
      return HttpResponse.json({
        bucket,
        since: url.searchParams.get('since') ?? FROZEN_NOW,
        until: url.searchParams.get('until') ?? FROZEN_NOW,
        buckets: activityFrom(rows, bucket),
      });
    }),
    http.get('*/functions/v1/memories', ({ request }) =>
      HttpResponse.json(listFrom(rows, new URL(request.url)))),
    http.get('*/auth/v1/user', () => HttpResponse.json(AUTH_USER)),
    http.post('*/auth/v1/user', () => HttpResponse.json(AUTH_USER)),
  ];
}
