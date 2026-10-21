/**
 * Deterministic MSW handlers for the visual Insights page stories.
 *
 * The shared `memoryHandlers()` read-activity fixture carries no `read_kind`,
 * which the Pulse timeline (correctly) counts as bulk — so the "Chosen" row
 * would always be empty. These handlers return typed reads, writes and runs
 * derived from the bucket's day only (never a clock or a PRNG), and make the
 * PREVIOUS window quieter than the current one so the strip's deltas render.
 */

import { http, HttpResponse } from 'msw';
import type { UsageRun, UsageStatRow } from '@lorekit/schemas/usage';
import { FROZEN_NOW, memoryHandlers, utilityHandlers } from '@/mocks/memories';
import { DAY_MS, HOUR_MS } from '@/lib/time-range';
const FROZEN = Date.parse(FROZEN_NOW);
/** Requests whose window starts before this are the "previous" window of the default 7d range. */
const CURRENT_FROM = FROZEN - 7 * DAY_MS;

const WRITES = [2, 0, 3, 1, 4, 0, 2, 1];
const BULK = [120, 80, 210, 150, 260, 40, 90, 180];
const CHOSEN = [2, 0, 4, 1, 6, 0, 1, 3];
const SCOPES = ['repo::mthines/lorekit', 'global', 'branch::mthines/lorekit::feat/insights'] as const;

function bucketsIn(since: string | null, until: string | null, unit: string | null): number[] {
  const step = unit === 'hour' ? HOUR_MS : DAY_MS;
  const from = Math.floor(Date.parse(since ?? new Date(FROZEN - 7 * DAY_MS).toISOString()) / step) * step;
  const to = Date.parse(until ?? FROZEN_NOW);
  const out: number[] = [];
  for (let t = from; t < to; t += step) out.push(t);
  return out;
}

/** Scales a window down to 60% when it is the previous window, so deltas are positive. */
function scaleFor(since: string | null): number {
  return since !== null && Date.parse(since) < CURRENT_FROM - HOUR_MS ? 0.6 : 1;
}

function row(overrides: Partial<UsageStatRow>): UsageStatRow {
  return {
    tool_name: 'memory.list',
    outcome: 'ok',
    scope_type: 'repo',
    client: 'mcp',
    kind: 'lesson',
    host: 'claude',
    event_count: 1,
    record_count: 1,
    total_duration_ms: 100,
    ...overrides,
  };
}

export const VISUAL_BY_TOOL: UsageStatRow[] = [
  row({ client: 'mcp', tool_name: 'memory.list', scope_type: 'repo', event_count: 640, record_count: 9_200, total_duration_ms: 96_000 }),
  row({ client: 'mcp', tool_name: 'memory.search', scope_type: 'global', event_count: 210, record_count: 2_400, total_duration_ms: 63_000 }),
  row({ client: 'cli', tool_name: 'memory.list', scope_type: 'branch', event_count: 380, record_count: 1_100, total_duration_ms: 41_000, host: 'aw' }),
  row({ client: 'cli', tool_name: 'memory.read', scope_type: 'repo', event_count: 44, record_count: 44, total_duration_ms: 3_900, host: 'aw' }),
  row({ client: 'dashboard', tool_name: 'memory.read', scope_type: 'project', event_count: 90, record_count: 90, total_duration_ms: 8_100, host: 'dashboard' }),
  row({ client: 'api', tool_name: 'memory.search', scope_type: 'repo', event_count: 30, record_count: 300, total_duration_ms: 9_000 }),
  row({ client: 'mcp', tool_name: 'memory.write', scope_type: 'repo', event_count: 26, record_count: 26, total_duration_ms: 5_200 }),
  row({ client: 'mcp', tool_name: 'memory.read', outcome: 'error', scope_type: 'branch', event_count: 6, record_count: 0, total_duration_ms: 600 }),
];

function at(daysAgo: number, hourUtc: number, minutes = 0): string {
  const midnight = Math.floor(FROZEN / DAY_MS) * DAY_MS;
  return new Date(midnight - daysAgo * DAY_MS + hourUtc * HOUR_MS + minutes * 60_000).toISOString();
}

function run(id: string, kind: string | null, daysAgo: number, hour: number, minutes: number, records: number, writes = 0): UsageRun {
  const first = at(daysAgo, hour);
  return {
    correlation_id: id,
    session_kind: kind,
    first_seen: first,
    last_seen: new Date(Date.parse(first) + minutes * 60_000).toISOString(),
    read_events: Math.max(1, Math.round(records / 20)),
    records_read: records,
    write_events: writes,
    distinct_scopes: 1 + (records % 3),
    total_duration_ms: minutes * 600,
  };
}

export const VISUAL_RUNS: UsageRun[] = [
  run('session:3f2a', 'local', 6, 9, 150, 420, 2),
  run('session:7c1d', 'local', 5, 13, 90, 260, 1),
  run('session:a91e', 'local', 4, 9, 200, 610, 3),
  run('session:c044', 'local', 2, 10, 60, 180),
  run('session:e5b7', 'local', 1, 14, 120, 300, 1),
  run('ci:build-1182', 'ci', 6, 2, 12, 90),
  run('ci:build-1190', 'ci', 4, 2, 14, 95),
  run('ci:build-1201', 'ci', 2, 2, 11, 88),
  run('ci:build-1214', 'ci', 0, 2, 13, 92),
  run('pr:mthines/lorekit#712', 'pr', 3, 11, 40, 340, 2),
  run('pr:mthines/lorekit#715', 'pr', 1, 9, 35, 290, 1),
  run('hook:unlabelled', null, 0, 8, 20, 60),
];

export function visualHandlers() {
  // MSW resolves in list order — every override precedes `...memoryHandlers()`.
  return [
    http.get('*/functions/v1/memories/activity', ({ request }) => {
      const url = new URL(request.url);
      const since = url.searchParams.get('since');
      const unit = url.searchParams.get('bucket');
      const scale = scaleFor(since);
      const buckets = bucketsIn(since, url.searchParams.get('until'), unit).flatMap((t, i) => {
        const count = Math.round((WRITES[i % WRITES.length] ?? 0) * scale);
        return count === 0 ? [] : [{ bucket: new Date(t).toISOString(), scope: SCOPES[i % SCOPES.length] ?? 'global', count }];
      });
      return HttpResponse.json({ bucket: unit ?? 'day', since, until: url.searchParams.get('until'), buckets });
    }),
    http.get('*/functions/v1/memories/read-activity', ({ request }) => {
      const url = new URL(request.url);
      const since = url.searchParams.get('since');
      const unit = url.searchParams.get('bucket');
      const scope = url.searchParams.get('scope');
      const scale = scaleFor(since);
      const buckets = bucketsIn(since, url.searchParams.get('until'), unit)
        .flatMap((t, i) => {
          const bucket = new Date(t).toISOString();
          const bulk = Math.round((BULK[i % BULK.length] ?? 0) * scale);
          const chosen = Math.round((CHOSEN[i % CHOSEN.length] ?? 0) * scale);
          return [
            { bucket, scope: SCOPES[0], read_kind: 'bulk' as const, count: Math.round(bulk * 0.6) },
            { bucket, scope: SCOPES[1], read_kind: 'bulk' as const, count: Math.round(bulk * 0.3) },
            { bucket, scope: null, read_kind: 'bulk' as const, count: bulk - Math.round(bulk * 0.6) - Math.round(bulk * 0.3) },
            { bucket, scope: SCOPES[2], read_kind: 'targeted' as const, count: chosen },
          ];
        })
        .filter((cell) => cell.count > 0 && (scope === null || cell.scope === scope));
      return HttpResponse.json({ bucket: unit ?? 'day', since, until: url.searchParams.get('until'), buckets });
    }),
    http.get('*/functions/v1/memories/usage', ({ request }) => {
      const url = new URL(request.url);
      const since = url.searchParams.get('since');
      const previous = scaleFor(since) < 1;
      return HttpResponse.json({
        range: { since, until: url.searchParams.get('until') },
        correlation_id: null,
        summary: {
          total_events: 1_426, reads: 1_394, writes: 26, other: 6,
          records_read: 13_134,
          archived: previous ? 1 : 3,
          expired: previous ? 0 : 2,
          by_outcome: { ok: 1_420, error: 6 },
        },
        by_tool: previous ? VISUAL_BY_TOOL.map((r) => ({ ...r, event_count: Math.round(r.event_count * 0.6) })) : VISUAL_BY_TOOL,
        by_scope_type: [],
      });
    }),
    http.get('*/functions/v1/memories/usage/runs', ({ request }) => {
      const url = new URL(request.url);
      return HttpResponse.json({
        range: { since: url.searchParams.get('since') ?? new Date(FROZEN - 90 * DAY_MS).toISOString(), until: FROZEN_NOW },
        runs: VISUAL_RUNS,
        next_cursor: null,
      });
    }),
    ...utilityHandlers(),
    ...memoryHandlers(),
  ];
}

/** An account with no activity at all — every section renders its empty state. */
export function emptyVisualHandlers() {
  const empty = (url: URL) => ({ bucket: url.searchParams.get('bucket') ?? 'day', since: url.searchParams.get('since'), until: url.searchParams.get('until'), buckets: [] });
  return [
    http.get('*/functions/v1/memories/activity', ({ request }) => HttpResponse.json(empty(new URL(request.url)))),
    http.get('*/functions/v1/memories/read-activity', ({ request }) => HttpResponse.json(empty(new URL(request.url)))),
    http.get('*/functions/v1/memories/usage', ({ request }) => {
      const url = new URL(request.url);
      return HttpResponse.json({
        range: { since: url.searchParams.get('since'), until: url.searchParams.get('until') },
        correlation_id: null,
        summary: { total_events: 0, reads: 0, writes: 0, other: 0, records_read: 0, archived: 0, expired: 0, by_outcome: {} },
        by_tool: [],
        by_scope_type: [],
      });
    }),
    http.get('*/functions/v1/memories/usage/runs', () =>
      HttpResponse.json({ range: { since: null, until: FROZEN_NOW }, runs: [], next_cursor: null }),
    ),
    ...utilityHandlers([]),
    ...memoryHandlers([]),
  ];
}
