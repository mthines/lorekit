/**
 * MSW fixtures + handlers for the LoreKit REST endpoints the dashboard's React
 * Query hooks call.
 *
 * These back the full-page / full-view visual-regression stories. The hooks
 * (`useScopeTree`, `useFacetCatalog`, `useLoreData`, `useDashboardData`, and the
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
 * period-over-period trend chips, the contribution heatmap — is stable
 * across runs. Never introduce a live `Date.now()` offset here: that is the
 * classic visual-regression flake source this module deliberately avoids.
 */
import { http, HttpResponse } from 'msw';
import { resolveKindHost } from '@lorekit/schemas/tags';

/**
 * The instant the story clock is frozen to. Fixtures below are dated relative to
 * it; `withFrozenClock(FROZEN_NOW)` pins the renderer to the same instant.
 */
export const FROZEN_NOW = '2026-06-15T12:00:00.000Z';

/**
 * Memory records the purge removed in the window — the Expired tile's number.
 *
 * A fixed constant rather than a value derived from `MEMORY_ROWS`, because
 * expired rows are DELETED: there is nothing left in the table to derive it
 * from, which is exactly why the figure comes from the usage ledger and not
 * from a row count. Non-round so a story asserting it cannot pass against a
 * placeholder zero or a coincidental total.
 */
export const EXPIRED_RECORDS = 17;

/**
 * Memory records archived in the window — the Lifecycle tile's headline number.
 * From the usage ledger for the same reason as {@link EXPIRED_RECORDS}, and
 * non-round so a story asserting it cannot pass against a placeholder zero.
 */
export const ARCHIVED_RECORDS = 42;

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
  /**
   * Taxonomy (migration 00056) — the bucket KIND and the owning HOST.
   *
   * Derived from the row's `loop::…` tags by the REAL `resolveKindHost`, not
   * hand-written per fixture, because that is precisely what the write path
   * does when a write carries no explicit values. A hand-maintained pair could
   * disagree with the tags beside it and the fixture would still look right.
   */
  kind: string | null;
  host: string | null;
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
  trigger: string | null = null,
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
    trigger,
    org_id: null,
    created_by: null,
    updated_by: null,
    org: null,
    origin_repo: origin.origin_repo ?? null,
    origin_branch: origin.origin_branch ?? null,
    origin_commit: origin.origin_commit ?? null,
    origin_pr: origin.origin_pr ?? null,
    // Inferred from the loop tags by the same function the write path calls, so
    // a fixture's taxonomy can never contradict the tags rendered next to it.
    ...resolveKindHost({ tags }),
  };
}

/**
 * A realistic spread of lore across every scope type (global, repo, branch,
 * project) and a range of ages, so the scope tree, heatmap, stat cards, and
 * lesson list all read as a lived-in workspace.
 */
export const MEMORY_ROWS: MemoryRow[] = [
  row('m01', 'global', 'aw-lessons::worktree-isolation', 'Always branch a worktree from the stacked PR head, never from main, or the diff double-counts the parent branch.', ['loop::aw-lessons', 'source::stuck-loop'], 3, 'aw', { origin_repo: 'mthines/lorekit', origin_branch: 'feat/Origin-Provenance', origin_commit: 'a1b2c3d4e5f60718', origin_pr: 482 }, 'stuck-loop'),
  row('m02', 'global', 'aw-lessons::npx-over-pnpm-exec', 'Run browser-mode Vitest via npx — pnpm exec keeps the Playwright child stdio open and the run never returns.', ['loop::aw-lessons'], 30, 'aw', {}, 'tool-failure'),
  row('m03', 'repo::mthines/lorekit', 'edge-parity::mirror-pattern', 'Pure logic that both mcp-core and the Deno edge need lives once in mcp-core and is mirrored self-contained; a spec guards drift.', ['architecture'], 26, 'claude', { origin_repo: 'mthines/lorekit', origin_branch: 'main' }, 'retrospective'),
  row('m04', 'repo::mthines/lorekit', 'scope-format::double-colon', 'The canonical scope separator is :: — a single colon is a 400. All segments lowercased.', ['scope', 'validation'], 50, 'claude'),
  row('m05', 'repo::mthines/lorekit', 'audit::one-vocabulary', 'AUDIT_ACTIONS is the single list; the SQL CHECK, the web copy, and the edge mirror are all asserted equal by a drift spec.', ['audit', 'loop::reviewer-comment-relevance'], 74, 'claude', { origin_repo: 'mthines/lorekit', origin_branch: 'main', origin_pr: 311 }, 'review-comment'),
  row('m06', 'repo::mthines/lorekit', 'rls::service-role-user-filter', 'api_key auth uses the service-role client — every query MUST .eq(user_id, userId) or it leaks across tenants.', ['security', 'rls', 'loop::review-outcomes'], 98, 'claude', {}, 'review-comment'),
  row('m07', 'branch::mthines/lorekit::feat/storybook', 'msw::wildcard-origin', 'Match the edge function with a */functions/v1 wildcard so the handler survives an unset NEXT_PUBLIC_SUPABASE_URL.', ['storybook', 'msw'], 5 * 24, 'claude', { origin_repo: 'mthines/lorekit', origin_branch: 'feat/storybook', origin_pr: 311 }, 'tool-failure'),
  row('m08', 'branch::mthines/lorekit::feat/storybook', 'snapshot::freeze-the-clock', 'Freeze Date before rendering any time-relative UI, or "3d ago" and trend chips flake the baseline overnight.', ['storybook', 'flake'], 5 * 24 + 6, 'claude', { origin_repo: 'mthines/lorekit', origin_branch: 'feat/storybook' }, 'tool-failure'),
  row('m09', 'project::agent-skills', 'routing::tier-detection', 'When in doubt, route Full — an over-planned Micro wastes compute, but an under-planned architectural task ships wrong code.', ['aw', 'routing'], 10 * 24, 'aw', { origin_repo: 'mthines/agent-skills', origin_branch: 'main' }, 'retrospective'),
  row('m10', 'project::agent-skills', 'confidence::plan-gate', 'A failed deterministic rule caps the confidence gate at 89% regardless of the LLM score.', ['aw', 'confidence'], 12 * 24, 'aw', { origin_repo: 'mthines/agent-skills', origin_branch: 'main' }, 'retrospective'),
  row('m11', 'repo::mthines/lorekit', 'otel::one-service-name', 'All five edge functions are one service "api"; tell them apart with faas.name, never a per-function SERVICE_NAME secret.', ['otel'], 15 * 24, 'claude'),
  row('m12', 'global', 'aw-lessons::no-ai-coauthor', 'Never add Co-Authored-By AI tags to commits or PRs in this workflow.', ['loop::aw-lessons'], 20 * 24, 'aw', {}, 'retrospective'),
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

/** `GET /memories/scopes` — one row per scope, count desc then scope asc
 *  (mirrors `lorekit_memory_scopes` since 00065, the same order as `/tags`). */
function scopesFrom(rows: MemoryRow[]) {
  const byScope = new Map<string, { count: number; last: string }>();
  for (const r of activeRows(rows, false)) {
    const prev = byScope.get(r.scope);
    if (!prev) byScope.set(r.scope, { count: 1, last: r.created_at });
    else byScope.set(r.scope, { count: prev.count + 1, last: r.created_at > prev.last ? r.created_at : prev.last });
  }
  return Array.from(byScope.entries())
    .sort(([a, av], [b, bv]) => bv.count - av.count || a.localeCompare(b))
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

/**
 * `GET /memories/facets` — one row per `(dimension, value)`, count desc then
 * value asc, exactly as `lorekit_memory_facets` orders it.
 *
 * Derived from the same `MEMORY_ROWS` as every other handler, so a fixture
 * added above appears in the filter menu without a second place to update.
 */
/**
 * The values a row carries for one facet — the mock's counterpart to
 * `lorekit_memory_facet_value` (migration 00090): one value for a scalar
 * dimension, one per label for `tag`, none when the column is null.
 */
function facetValues(r: MemoryRow, facet: string): string[] {
  if (facet === 'tag') return r.tags.map((t) => String(t).trim()).filter(Boolean);
  const raw: Record<string, unknown> = {
    source_agent: r.source_agent,
    trigger: r.trigger,
    kind: r.kind,
    host: r.host,
    origin_repo: r.origin_repo,
    origin_branch: r.origin_branch,
    origin_pr: r.origin_pr,
    owner: 'personal',
  };
  const v = raw[facet];
  if (v === null || v === undefined) return [];
  const text = String(v).trim();
  return text ? [text] : [];
}

/**
 * `POST /memories/pivot`, mocked.
 *
 * Deliberately does NOT apply the request's dimension filters: the real endpoint
 * self-excludes both axes, and the stories drive the grid through the axis
 * selects rather than the filter bar. A half-implemented filter here would agree
 * with itself and with nothing else.
 */
function pivotFrom(rows: MemoryRow[], row: string, col: string, archived: boolean) {
  const counts = new Map<string, number>();
  for (const r of activeRows(rows, archived)) {
    for (const rowValue of facetValues(r, row)) {
      for (const colValue of facetValues(r, col)) {
        const cellKey = `${rowValue}\u0000${colValue}`;
        counts.set(cellKey, (counts.get(cellKey) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([cellKey, count]) => {
      const [rowValue = '', colValue = ''] = cellKey.split('\u0000');
      return { row: rowValue, col: colValue, count };
    })
    .sort((a, b) => b.count - a.count || a.row.localeCompare(b.row) || a.col.localeCompare(b.col));
}

function facetsFrom(rows: MemoryRow[], archived: boolean) {
  const counts = new Map<string, number>();
  const bump = (facet: string, value: string | number | null) => {
    if (value === null || value === undefined) return;
    const v = String(value).trim();
    if (!v) return;
    const cellKey = `${facet}\u0000${v}`;
    counts.set(cellKey, (counts.get(cellKey) ?? 0) + 1);
  };

  for (const r of activeRows(rows, archived)) {
    for (const tag of r.tags) bump('tag', tag);
    bump('source_agent', r.source_agent);
    bump('trigger', r.trigger);
    bump('kind', r.kind);
    bump('host', r.host);
    bump('origin_repo', r.origin_repo);
    bump('origin_branch', r.origin_branch);
    bump('origin_pr', r.origin_pr);
    // Owner (migration 00064): `personal` for org-less rows, else the org slug.
    bump('owner', r.org ? r.org.slug : 'personal');
  }

  return Array.from(counts.entries())
    .map(([cellKey, count]) => {
      const [facet, value] = cellKey.split('\u0000') as [string, string];
      return { facet, value, count };
    })
    .sort(
      (a, b) =>
        a.facet.localeCompare(b.facet) || b.count - a.count || a.value.localeCompare(b.value),
    );
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
 * `GET /memories/read-activity` — records read per UTC hour/day AND per scope.
 *
 * Reads live in `usage_events`, which the fixtures do not model, so this is the
 * one handler that cannot derive its response from `MEMORY_ROWS`. It instead
 * synthesises a plausible read ledger FROM those rows: a memory that exists is
 * a memory that gets read back, so each fixture contributes a small, fixed
 * number of records in its own bucket. Fixed, not random — the same
 * determinism rule the timestamps follow (see the module docblock).
 *
 * Cells are `(bucket, scope)`, the shape `activityFrom` already emits and the
 * one `ReadActivityBucketSchema` requires since migration 00058. `scope` is
 * nullable on the wire (a read the server could not attribute), but a
 * synthesised read always knows which memory it came from, so this fixture
 * never emits null — the null case belongs in a schema/unit test, not in a
 * story's baseline data.
 */
function readActivityFrom(rows: MemoryRow[], unit: 'hour' | 'day') {
  const cells = new Map<string, { bucket: string; scope: string; count: number }>();
  for (const [i, r] of activeRows(rows, false).entries()) {
    const bucket = unit === 'hour'
      ? `${r.created_at.slice(0, 13)}:00:00.000Z`
      : `${r.created_at.slice(0, 10)}T00:00:00.000Z`;
    // 3, 5, 7, 3, … records — a stable spread, never a clock or a PRNG.
    const records = 3 + ((i * 2) % 6);
    const cellKey = `${bucket}|${r.scope}`;
    const prev = cells.get(cellKey);
    if (prev) prev.count += records;
    else cells.set(cellKey, { bucket, scope: r.scope, count: records });
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
 * `packages/smoke-tests/src/memories-api.integration.spec.ts` → "list filters".
 * Keep the semantics here roughly faithful so stories stay realistic, but never
 * treat this as the check.
 */
/**
 * The shared row predicate — scope + label + the scalar dimensions — that both
 * `GET /memories` and (since migration 00063) `GET /memories/activity` apply. It
 * lives here once so the stat header's numbers narrow the same way the list does
 * in a story. Any param that is absent is a no-op, so the activity handler — which
 * sends `scope` + the dimension filters but never `key`/`q`/`archived` — reuses it
 * unchanged.
 */
function filterRows(rows: MemoryRow[], url: URL): MemoryRow[] {
  const scope = url.searchParams.get('scope');
  const key = url.searchParams.get('key');
  const q = url.searchParams.get('q')?.toLowerCase();
  const tags = url.searchParams.get('tags')?.split(',').filter(Boolean) ?? [];
  const tagsMode = url.searchParams.get('tags_mode') ?? 'any';

  /** One scalar dimension: `in` (default) or `nin`, both over the raw column. */
  const scalar = (param: string, read: (r: MemoryRow) => string | number | null) => {
    const values = url.searchParams.get(param)?.split(',').filter(Boolean) ?? [];
    if (values.length === 0) return () => true;
    const nin = url.searchParams.get(`${param}_mode`) === 'nin';
    return (r: MemoryRow) => {
      const raw = read(r);
      const hit = raw !== null && raw !== undefined && values.includes(String(raw));
      return nin ? !hit : hit;
    };
  };

  return activeRows(rows, url.searchParams.get('archived') === 'true')
    .filter((r) => (scope ? r.scope === scope : true))
    .filter((r) => (key ? r.key === key : true))
    .filter((r) => (q ? `${r.key} ${r.value}`.toLowerCase().includes(q) : true))
    .filter((r) => (tags.length === 0
      ? true
      : tagsMode === 'all'
        ? tags.every((t) => r.tags.includes(t))
        : tagsMode === 'none'
          ? !tags.some((t) => r.tags.includes(t))
          : tags.some((t) => r.tags.includes(t))))
    .filter(scalar('source_agent', (r) => r.source_agent))
    .filter(scalar('trigger', (r) => r.trigger))
    .filter(scalar('kind', (r) => r.kind))
    .filter(scalar('host', (r) => r.host))
    .filter(scalar('origin_repo', (r) => r.origin_repo))
    .filter(scalar('origin_branch', (r) => r.origin_branch))
    .filter(scalar('origin_pr', (r) => r.origin_pr))
    // Owner (00064) — the computed identity `personal` / org slug, not a raw
    // column, so it cannot reuse `scalar`. `in` (default) or `nin`.
    .filter((r) => {
      const values = url.searchParams.get('owner')?.split(',').filter(Boolean) ?? [];
      if (values.length === 0) return true;
      const identity = r.org ? r.org.slug : 'personal';
      const hit = values.includes(identity);
      return url.searchParams.get('owner_mode') === 'nin' ? !hit : hit;
    });
}

function listFrom(rows: MemoryRow[], url: URL) {
  const limit = Number(url.searchParams.get('limit') ?? 50);
  // Honour `sort` rather than pinning one: the route defaults to `updated_at`,
  // but `listMemories` (lib/lore.ts) always sends `sort: 'created_at'`, so the
  // Explorer reads in creation order. A mock that pinned EITHER value would
  // render one order while the caller asked for another, which is the sort of
  // difference a screenshot baseline then freezes in place.
  const sort = url.searchParams.get('sort') === 'created_at' ? 'created_at' : 'updated_at';
  const matched = filterRows(rows, url).sort((a, b) => String(b[sort]).localeCompare(String(a[sort])));
  // No cursor emulation: every story fits in one page, and a fake cursor would
  // encode a pagination contract the fixtures do not actually implement.
  // `total` mirrors the real route's `count(*) over ()` (migration 00094):
  // every row FILTERING matched, before `limit` trims the page.
  return { entries: matched.slice(0, limit), hasMore: false, nextCursor: null, total: matched.length };
}

/**
 * Re-spell a body request as the URL the GET handlers above already understand.
 *
 * The mock keeps ONE predicate for the same reason the edge function does: the
 * body routes are the query routes in another encoding, and a second
 * reimplementation here could disagree with the first while both stories stayed
 * green. Arrays are comma-joined because that is precisely what the query
 * transport does — the mock is not the place to reproduce the wall the real
 * transport has, only the semantics.
 */
function urlFromBody(body: Record<string, unknown>): URL {
  const url = new URL('http://mock/memories');
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return url;
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
    http.get('*/functions/v1/memories/facets', ({ request }) => {
      const url = new URL(request.url);
      const only = url.searchParams.get('facets')?.split(',').filter(Boolean) ?? [];
      const all = facetsFrom(rows, url.searchParams.get('archived') === 'true');
      return HttpResponse.json({
        facets: only.length ? all.filter((f) => only.includes(f.facet)) : all,
      });
    }),
    http.get('*/functions/v1/memories/activity', ({ request }) => {
      const url = new URL(request.url);
      const bucket = url.searchParams.get('bucket') === 'hour' ? 'hour' : 'day';
      return HttpResponse.json({
        bucket,
        since: url.searchParams.get('since') ?? FROZEN_NOW,
        until: url.searchParams.get('until') ?? FROZEN_NOW,
        // Scope + dimension filters narrow the aggregate server-side (00063), so
        // the mock applies the SAME predicate the list uses — else a scoped header
        // would show the account total.
        buckets: activityFrom(filterRows(rows, url), bucket),
      });
    }),
    http.get('*/functions/v1/memories/read-activity', ({ request }) => {
      const url = new URL(request.url);
      const bucket = url.searchParams.get('bucket') === 'hour' ? 'hour' : 'day';
      // `?scope=` is an EXACT match on the real endpoint (`ue.scope = p_scope`,
      // 00058), never a prefix or a wildcard — the unfiltered call is the one
      // that also returns the unattributable NULL-scope remainder. Honour it
      // here or a filtered story renders every scope and silently looks like
      // the filter does nothing.
      const scope = url.searchParams.get('scope');
      const buckets = readActivityFrom(rows, bucket)
        .filter((cell) => scope === null || cell.scope === scope);
      return HttpResponse.json({
        bucket,
        since: url.searchParams.get('since') ?? FROZEN_NOW,
        until: url.searchParams.get('until') ?? FROZEN_NOW,
        buckets,
      });
    }),
    http.get('*/functions/v1/memories/usage', ({ request }) => {
      const url = new URL(request.url);
      // The Explorer's stats header reads exactly one figure from this
      // endpoint: `summary.expired`. Everything else is filled in to the real
      // response's SHAPE rather than left out, so a consumer that starts
      // reading another field gets a plausible number instead of `undefined`.
      //
      // Deliberately NOT derived from the fixture rows and deliberately NOT
      // scope-aware: expiry is recorded per purge run, the purge spans scopes,
      // and the real endpoint takes no `scope` at all. A mock that filtered by
      // scope would let a story "prove" a per-scope expiry figure the API
      // cannot produce.
      const expired = EXPIRED_RECORDS;
      return HttpResponse.json({
        range: {
          since: url.searchParams.get('since') ?? null,
          until: url.searchParams.get('until') ?? null,
        },
        correlation_id: url.searchParams.get('correlation_id'),
        summary: {
          total_events: 128,
          reads: 96,
          writes: 24,
          other: 8,
          records_read: 1_284,
          record_count: 1_284,
          event_count: 128,
          archived: ARCHIVED_RECORDS,
          expired,
          by_outcome: { ok: 126, error: 2 },
        },
        by_tool: [],
        by_scope_type: [],
      });
    }),
    http.get('*/functions/v1/memories', ({ request }) =>
      HttpResponse.json(listFrom(rows, new URL(request.url)))),
    // The BODY transport the dashboard uses. Same predicate, other encoding —
    // a story that mocked only the GET form would render an empty Explorer.
    http.post('*/functions/v1/memories/list', async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return HttpResponse.json(listFrom(rows, urlFromBody(body)));
    }),
    http.post('*/functions/v1/memories/facets', async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const only = (body.facets as string[] | undefined) ?? [];
      const all = facetsFrom(rows, body.archived === true);
      return HttpResponse.json({
        facets: only.length ? all.filter((f) => only.includes(f.facet)) : all,
      });
    }),
    http.post('*/functions/v1/memories/pivot', async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const row = String(body.row ?? 'host');
      const col = String(body.col ?? 'kind');
      return HttpResponse.json({
        row,
        col,
        cells: pivotFrom(rows, row, col, body.archived === true),
        truncated: false,
      });
    }),
    http.post('*/functions/v1/memories/activity', async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const url = urlFromBody(body);
      const bucket = body.bucket === 'hour' ? 'hour' : 'day';
      return HttpResponse.json({
        bucket,
        since: (body.since as string | undefined) ?? FROZEN_NOW,
        until: (body.until as string | undefined) ?? FROZEN_NOW,
        buckets: activityFrom(filterRows(rows, url), bucket),
      });
    }),
    http.get('*/auth/v1/user', () => HttpResponse.json(AUTH_USER)),
    http.post('*/auth/v1/user', () => HttpResponse.json(AUTH_USER)),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// Retention policies ("grooming") — Settings → Grooming's rule builder.
// Separate from `memoryHandlers()` (a different page's concern), but the SAME
// pattern: derive every response from an in-memory fixture the caller can
// override, and mutate it in place so a story's create/update/delete round
// trips are visible on the next read within the same render.
// ═══════════════════════════════════════════════════════════════════════════

export interface MockRetentionPolicy {
  id: string;
  scope: string;
  name: string;
  mode: 'review' | 'auto';
  enabled: boolean;
  min_age_days: number | null;
  unseen_days: number | null;
  max_seen_count: number | null;
  max_read_count: number | null;
  max_opened_count: number | null;
  // The eight dimension filters (migration 00093) — mirrors `RetentionPolicySchema`
  // exactly so this fixture stays a faithful stand-in for the real response shape.
  tags: string[] | null;
  tags_mode: 'any' | 'all' | 'none' | null;
  source_agent: string[] | null;
  source_agent_mode: 'in' | 'nin' | null;
  trigger: string[] | null;
  trigger_mode: 'in' | 'nin' | null;
  kind: string[] | null;
  kind_mode: 'in' | 'nin' | null;
  host: string[] | null;
  host_mode: 'in' | 'nin' | null;
  origin_repo: string[] | null;
  origin_repo_mode: 'in' | 'nin' | null;
  origin_branch: string[] | null;
  origin_branch_mode: 'in' | 'nin' | null;
  origin_pr: string[] | null;
  origin_pr_mode: 'in' | 'nin' | null;
  created_at: string;
  updated_at: string;
}

/**
 * A freshly-created/updated policy's dimension filters — every filter
 * cleared. Exported so a story's own fixtures (`GroomingRuleBuilder.stories.tsx`)
 * can spread it in rather than repeating all sixteen `null` fields.
 */
export const NO_MOCK_DIMENSION_FILTERS = {
  tags: null, tags_mode: null,
  source_agent: null, source_agent_mode: null,
  trigger: null, trigger_mode: null,
  kind: null, kind_mode: null,
  host: null, host_mode: null,
  origin_repo: null, origin_repo_mode: null,
  origin_branch: null, origin_branch_mode: null,
  origin_pr: null, origin_pr_mode: null,
} as const;

export const DEFAULT_GROOM_POLICIES: MockRetentionPolicy[] = [
  {
    id: 'policy-1',
    scope: 'repo::acme/app',
    name: 'Stale repo lore',
    mode: 'review',
    enabled: false,
    min_age_days: 90,
    unseen_days: null,
    max_seen_count: null,
    max_read_count: null,
    max_opened_count: null,
    ...NO_MOCK_DIMENSION_FILTERS,
    created_at: FROZEN_NOW,
    updated_at: FROZEN_NOW,
  },
];

/** The candidates `groom/preview` and `groom/run` report for any scoped request. */
export const GROOM_CANDIDATE_KEYS: { scope: string; key: string }[] = [
  { scope: 'repo::acme/app', key: 'stale-onboarding-note' },
  { scope: 'repo::acme/app', key: 'old-flaky-test-workaround' },
  { scope: 'repo::acme/app', key: 'deprecated-api-migration' },
];

/**
 * Handlers for `/policies`, `/groom/preview`, `/groom/run`, `/protect` —
 * grooming's page-specific mock server. Each call captures its own mutable
 * `policies`/`protectedKeys` state (module-scope `let`, closed over by the
 * returned handlers), so calling this again for a fresh story resets it.
 */
export function groomHandlers(initialPolicies: MockRetentionPolicy[] = DEFAULT_GROOM_POLICIES) {
  let policies = initialPolicies.map((p) => ({ ...p }));
  const protectedKeys = new Set<string>();

  return [
    http.get('*/functions/v1/memories/policies', () => HttpResponse.json({ entries: policies })),

    http.post('*/functions/v1/memories/policies', async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const dimensionFilters = Object.fromEntries(
        Object.keys(NO_MOCK_DIMENSION_FILTERS).map((field) => [
          field,
          field in body ? (body[field] as never) : null,
        ]),
      ) as typeof NO_MOCK_DIMENSION_FILTERS;
      const policy: MockRetentionPolicy = {
        id: `policy-${policies.length + 1}`,
        scope: String(body.scope ?? ''),
        name: String(body.name ?? ''),
        mode: body.mode === 'auto' ? 'auto' : 'review',
        enabled: body.enabled === true,
        min_age_days: typeof body.min_age_days === 'number' ? body.min_age_days : null,
        unseen_days: typeof body.unseen_days === 'number' ? body.unseen_days : null,
        max_seen_count: typeof body.max_seen_count === 'number' ? body.max_seen_count : null,
        max_read_count: typeof body.max_read_count === 'number' ? body.max_read_count : null,
        max_opened_count: typeof body.max_opened_count === 'number' ? body.max_opened_count : null,
        ...dimensionFilters,
        created_at: FROZEN_NOW,
        updated_at: FROZEN_NOW,
      };
      policies = [...policies, policy];
      return HttpResponse.json(policy);
    }),

    http.patch('*/functions/v1/memories/policies/:id', async ({ request, params }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const idx = policies.findIndex((p) => p.id === params.id);
      if (idx === -1) return new HttpResponse(null, { status: 404 });
      const current = policies[idx] as MockRetentionPolicy;
      const dimensionPatch = Object.fromEntries(
        Object.keys(NO_MOCK_DIMENSION_FILTERS)
          .filter((field) => field in body)
          .map((field) => [field, body[field] as never]),
      );
      const updated: MockRetentionPolicy = {
        ...current,
        ...('name' in body ? { name: String(body.name) } : {}),
        ...('mode' in body ? { mode: (body.mode === 'auto' ? 'auto' : 'review') as 'auto' | 'review' } : {}),
        ...('enabled' in body ? { enabled: body.enabled === true } : {}),
        ...('min_age_days' in body ? { min_age_days: body.min_age_days as number | null } : {}),
        ...('unseen_days' in body ? { unseen_days: body.unseen_days as number | null } : {}),
        ...('max_seen_count' in body ? { max_seen_count: body.max_seen_count as number | null } : {}),
        ...('max_read_count' in body ? { max_read_count: body.max_read_count as number | null } : {}),
        ...('max_opened_count' in body ? { max_opened_count: body.max_opened_count as number | null } : {}),
        ...dimensionPatch,
        updated_at: FROZEN_NOW,
      };
      policies = [...policies.slice(0, idx), updated, ...policies.slice(idx + 1)];
      return HttpResponse.json(updated);
    }),

    http.delete('*/functions/v1/memories/policies/:id', ({ params }) => {
      const before = policies.length;
      policies = policies.filter((p) => p.id !== params.id);
      if (policies.length === before) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json({ deleted: true });
    }),

    http.post('*/functions/v1/memories/groom/preview', async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const hasScope = typeof body.scope === 'string' && body.scope.length > 0;
      const keys = hasScope
        ? GROOM_CANDIDATE_KEYS.filter((k) => !protectedKeys.has(`${k.scope}::${k.key}`))
        : [];
      return HttpResponse.json({ count: keys.length, keys });
    }),

    http.post('*/functions/v1/memories/groom/run', async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const hasScope = typeof body.scope === 'string' && body.scope.length > 0;
      const keys = hasScope
        ? GROOM_CANDIDATE_KEYS.filter((k) => !protectedKeys.has(`${k.scope}::${k.key}`))
        : [];
      return HttpResponse.json({ archived: keys.length, keys });
    }),

    http.post('*/functions/v1/memories/protect', async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const key = `${String(body.scope ?? '')}::${String(body.key ?? '')}`;
      if (body.protected === true) protectedKeys.add(key);
      else protectedKeys.delete(key);
      return HttpResponse.json({ protected: body.protected === true });
    }),
  ];
}
