/**
 * Runs as time: a weekday × hour rhythm and swimlanes per session kind, both
 * from `GET /memories/usage/runs`.
 *
 * ## Why runs, and not the hourly activity series
 *
 * A "when do my agents work" heatmap needs hourly data across the whole window.
 * `/memories/activity` and `/read-activity` can return hourly buckets, but one
 * row per (hour, scope[, read_kind]) — a week of hours across a dozen scopes is
 * thousands of rows, past PostgREST's 1000-row `max_rows`, and the RPC drops the
 * newest rows silently. `/usage/runs` is keyset-paginated instead, so every page
 * is complete and the page count is the only bound, which the caller states.
 *
 * The cost of that choice is coverage: a run is a `correlation_id`, which the
 * LoreKit hooks and MCP clients stamp on their calls. A call that carries none
 * is in the activity series but not here. The components caption this.
 *
 * ## The viewer's time zone, injected
 *
 * Buckets are placed in the time zone passed in (the browser's, in the page),
 * never the server's UTC: "agents mostly work at 14:00" is a statement about
 * the reader's day. The zone is a parameter rather than read inside so the
 * specs are deterministic on any machine.
 */

import type { UsageRun } from '@lorekit/schemas/usage';
import type { AbsoluteRange } from '@/lib/time-range';

/** Monday-first, matching the contribution heatmap's rows. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

/** Weekday (0 = Monday) and hour (0–23) of an instant in `timeZone`, or `null` if unparseable. */
export function localParts(iso: string, timeZone: string): { weekday: number; hour: number } | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const parts = formatterFor(timeZone).formatToParts(new Date(t));
  const weekday = WEEKDAY_INDEX[parts.find((p) => p.type === 'weekday')?.value ?? ''];
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  if (weekday === undefined || Number.isNaN(hour)) return null;
  return { weekday, hour: hour % 24 };
}

export interface RhythmGrid {
  /** `cells[weekday][hour]` — runs that STARTED in that local hour. */
  cells: number[][];
  max: number;
  total: number;
}

/**
 * Runs started per local weekday × hour.
 *
 * Counted by start (`first_seen`) rather than spread across every hour a run
 * was active: a run is one decision to start work, and spreading a three-hour
 * CI job over three cells would weight long runs as if they were three runs.
 */
export function rhythmGrid(runs: readonly UsageRun[], timeZone: string): RhythmGrid {
  const cells = WEEKDAYS.map(() => Array.from({ length: 24 }, () => 0));
  let total = 0;
  for (const run of runs) {
    const parts = localParts(run.first_seen, timeZone);
    const row = parts ? cells[parts.weekday] : undefined;
    if (!parts || !row) continue;
    row[parts.hour] = (row[parts.hour] ?? 0) + 1;
    total += 1;
  }
  const max = Math.max(0, ...cells.flat());
  return { cells, max, total };
}

/** The lanes, in display order. `unknown` covers a null or unrecognised `session_kind`. */
export const RUN_LANES = ['local', 'ci', 'pr', 'unknown'] as const;
export type RunLane = (typeof RUN_LANES)[number];

export const RUN_LANE_LABEL: Record<RunLane, string> = {
  local: 'Local sessions',
  ci: 'CI jobs',
  pr: 'PR automations',
  unknown: 'Unlabelled',
};

export function runLane(sessionKind: string | null): RunLane {
  return sessionKind === 'local' || sessionKind === 'ci' || sessionKind === 'pr' ? sessionKind : 'unknown';
}

export interface SwimlaneRun {
  run: UsageRun;
  lane: RunLane;
  /** Start and end as fractions of the window, clamped to [0, 1]. */
  x0: number;
  x1: number;
}

export interface Swimlanes {
  lanes: { lane: RunLane; runs: SwimlaneRun[] }[];
  /** The largest `records_read` of any placed run — the bar-thickness scale. */
  maxRecordsRead: number;
}

/**
 * Place runs on the window's time axis, one lane per session kind.
 *
 * Only lanes with runs are returned, so an account that never runs CI does not
 * carry an empty "CI jobs" row. A run reaching outside the window is clamped to
 * its edge rather than dropped: it did touch lore inside the window.
 */
export function swimlanes(runs: readonly UsageRun[], window: AbsoluteRange): Swimlanes {
  const from = Date.parse(window.from);
  const span = Date.parse(window.to) - from;
  const byLane = new Map<RunLane, SwimlaneRun[]>();
  let maxRecordsRead = 0;
  if (Number.isNaN(from) || !(span > 0)) return { lanes: [], maxRecordsRead };

  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  for (const run of runs) {
    const start = Date.parse(run.first_seen);
    const end = Date.parse(run.last_seen);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const x0 = clamp((start - from) / span);
    const x1 = clamp((Math.max(start, end) - from) / span);
    const lane = runLane(run.session_kind);
    const list = byLane.get(lane) ?? [];
    list.push({ run, lane, x0, x1 });
    byLane.set(lane, list);
    maxRecordsRead = Math.max(maxRecordsRead, run.records_read);
  }

  return {
    lanes: RUN_LANES.flatMap((lane) => {
      const laneRuns = byLane.get(lane);
      return laneRuns ? [{ lane, runs: laneRuns.sort((a, b) => a.x0 - b.x0) }] : [];
    }),
    maxRecordsRead,
  };
}
