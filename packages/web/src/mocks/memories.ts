/**
 * MSW fixtures + handlers for the Supabase REST (PostgREST) endpoints the
 * dashboard's React Query hooks call.
 *
 * These back the full-page / full-view visual-regression stories: the hooks
 * (`useScopeTree`, `useLoreData`, `useDashboardData`, and the `listMemories`
 * server action, which — with `next/headers` auto-mocked by
 * `@storybook/nextjs-vite` — executes in the browser and issues the same
 * PostgREST fetch) all read `GET /rest/v1/memories`. One rich fixture set
 * therefore drives every consumer: each reads only the columns it needs off the
 * returned rows.
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

/** A single fully-shaped `memories` row as PostgREST returns it. */
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
  /** Embedded `orgs(name,slug)` join — null for personal lore. */
  orgs: { name: string; slug: string } | null;
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
    orgs: null,
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
  row('m07', 'branch::mthines/lorekit::feat/storybook', 'msw::wildcard-origin', 'Match PostgREST with a */rest/v1 wildcard so the handler survives an unset NEXT_PUBLIC_SUPABASE_URL.', ['storybook', 'msw'], 5 * 24, 'claude', { origin_repo: 'mthines/lorekit', origin_branch: 'feat/storybook', origin_pr: 311 }),
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

/**
 * Handlers that mock every Supabase endpoint the lore/dashboard hooks touch.
 * Origin is wild-carded so a story renders identically whether or not
 * `NEXT_PUBLIC_SUPABASE_URL` was injected into the build.
 *
 * @param rows override the default fixture set (e.g. to story an empty state).
 */
export function memoryHandlers(rows: MemoryRow[] = MEMORY_ROWS) {
  return [
    http.get('*/rest/v1/memories', () => HttpResponse.json(rows)),
    http.get('*/auth/v1/user', () => HttpResponse.json(AUTH_USER)),
    http.post('*/auth/v1/user', () => HttpResponse.json(AUTH_USER)),
  ];
}
