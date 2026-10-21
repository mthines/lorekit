import { describe, expect, it } from 'vitest';
import type { UsageRun } from '@lorekit/schemas/usage';
import { MAX_LANE_ROWS, localParts, packRows, rhythmGrid, runLane, swimlanes } from './runs-rhythm';

function run(overrides: Partial<UsageRun>): UsageRun {
  return {
    correlation_id: 'session:1',
    session_kind: 'local',
    first_seen: '2026-06-15T09:00:00.000Z',
    last_seen: '2026-06-15T10:00:00.000Z',
    read_events: 1,
    records_read: 10,
    write_events: 0,
    distinct_scopes: 1,
    total_duration_ms: 100,
    ...overrides,
  };
}

describe('localParts', () => {
  it('places an instant in the given time zone, Monday-first', () => {
    // 2026-06-15 is a Monday. 23:30 UTC is already Tuesday 01:30 in Copenhagen (UTC+2).
    expect(localParts('2026-06-15T23:30:00.000Z', 'UTC')).toEqual({ weekday: 0, hour: 23 });
    expect(localParts('2026-06-15T23:30:00.000Z', 'Europe/Copenhagen')).toEqual({ weekday: 1, hour: 1 });
  });

  it('returns null for an unparseable instant', () => {
    expect(localParts('not-a-date', 'UTC')).toBeNull();
  });
});

describe('rhythmGrid', () => {
  it('counts runs by local start hour, not by every hour they were active', () => {
    const grid = rhythmGrid(
      [
        run({ first_seen: '2026-06-15T09:10:00.000Z', last_seen: '2026-06-15T12:00:00.000Z' }),
        run({ first_seen: '2026-06-15T09:50:00.000Z' }),
        run({ first_seen: '2026-06-17T14:00:00.000Z' }),
      ],
      'UTC',
    );
    expect(grid.cells[0]?.[9]).toBe(2);
    expect(grid.cells[0]?.[10]).toBe(0);
    expect(grid.cells[2]?.[14]).toBe(1);
    expect(grid).toMatchObject({ max: 2, total: 3 });
  });

  it('is all zeros for no runs', () => {
    expect(rhythmGrid([], 'UTC')).toMatchObject({ max: 0, total: 0 });
  });
});

describe('runLane', () => {
  it('maps a null or unknown session kind to the unlabelled lane', () => {
    expect(runLane('ci')).toBe('ci');
    expect(runLane(null)).toBe('unknown');
    expect(runLane('cron')).toBe('unknown');
  });
});

describe('swimlanes', () => {
  const window = { from: '2026-06-15T00:00:00.000Z', to: '2026-06-16T00:00:00.000Z' };

  it('places runs as fractions of the window, only in lanes that have runs, in lane order', () => {
    const result = swimlanes(
      [
        run({ session_kind: 'pr', first_seen: '2026-06-15T12:00:00.000Z', last_seen: '2026-06-15T18:00:00.000Z', records_read: 40 }),
        run({ session_kind: 'local', first_seen: '2026-06-15T06:00:00.000Z', last_seen: '2026-06-15T06:00:00.000Z' }),
      ],
      window,
    );
    expect(result.lanes.map((l) => l.lane)).toEqual(['local', 'pr']);
    expect(result.lanes[1]?.runs[0]).toMatchObject({ x0: 0.5, x1: 0.75 });
    expect(result.lanes[0]?.runs[0]).toMatchObject({ x0: 0.25, x1: 0.25 });
    expect(result.maxRecordsRead).toBe(40);
  });

  it('clamps a run that reaches outside the window instead of dropping it', () => {
    const result = swimlanes(
      [run({ first_seen: '2026-06-14T20:00:00.000Z', last_seen: '2026-06-15T06:00:00.000Z' })],
      window,
    );
    expect(result.lanes[0]?.runs[0]).toMatchObject({ x0: 0, x1: 0.25 });
  });

  it('stacks overlapping runs into sub-rows and reports how many rows the lane needs', () => {
    const result = swimlanes(
      [
        run({ correlation_id: 'a', first_seen: '2026-06-15T01:00:00.000Z', last_seen: '2026-06-15T20:00:00.000Z' }),
        run({ correlation_id: 'b', first_seen: '2026-06-15T02:00:00.000Z', last_seen: '2026-06-15T03:00:00.000Z' }),
        run({ correlation_id: 'c', first_seen: '2026-06-15T06:00:00.000Z', last_seen: '2026-06-15T07:00:00.000Z' }),
      ],
      window,
    );
    const lane = result.lanes[0];
    expect(lane?.rows).toBe(2);
    const rowOf = (id: string) => lane?.runs.find((r) => r.run.correlation_id === id)?.row;
    expect(rowOf('a')).toBe(0);
    // b overlaps a, so it goes below; c starts after b ends, so it reuses b's row.
    expect(rowOf('b')).toBe(1);
    expect(rowOf('c')).toBe(1);
  });

  it('returns no lanes for a degenerate window', () => {
    expect(swimlanes([run({})], { from: window.to, to: window.from }).lanes).toEqual([]);
  });
});

describe('packRows', () => {
  const r = (x0: number, x1: number) => ({ run: run({}), lane: 'local' as const, x0, x1 });

  it('caps a lane at MAX_LANE_ROWS, overlapping in the row that frees up first', () => {
    const many = Array.from({ length: MAX_LANE_ROWS + 2 }, (_, i) => r(0.1 + i * 0.001, 0.9 - i * 0.01));
    const packed = packRows(many);
    expect(Math.max(...packed.map((p) => p.row))).toBe(MAX_LANE_ROWS - 1);
  });

  it('counts an instant run as its drawn width, so two near-simultaneous bars do not overlap on screen', () => {
    const packed = packRows([r(0.5, 0.5), r(0.505, 0.505)]);
    expect(packed.map((p) => p.row)).toEqual([0, 1]);
  });

  it('reuses a row once its last run has ended', () => {
    expect(packRows([r(0.1, 0.2), r(0.3, 0.4)]).map((p) => p.row)).toEqual([0, 0]);
  });
});
