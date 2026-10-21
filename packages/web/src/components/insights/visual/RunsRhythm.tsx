'use client';

/**
 * RunsRhythm — when your agents start work with lore: runs started per local
 * weekday × hour (`lib/runs-rhythm.ts#rhythmGrid`).
 *
 * Built from runs rather than the hourly activity series for the reason in
 * that module's docblock (the hourly series would hit the row cap silently);
 * the caption states the coverage that choice costs — calls without a run id
 * are not placed.
 *
 * One tab stop; arrow keys move the cell in two dimensions, Home/End jump to
 * the row's ends, Escape clears. The readout is one live line beneath the grid
 * rather than a floating panel, because a 7 × 24 grid of 168 small cells has
 * no edge a floating panel could avoid covering.
 */

import { useState, type KeyboardEvent } from 'react';
import { WEEKDAYS, rhythmGrid } from '@/lib/runs-rhythm';
import type { UsageRun } from '@lorekit/schemas/usage';

interface RunsRhythmProps {
  runs: readonly UsageRun[];
  timeZone: string;
}

const HOUR_TICKS = [0, 6, 12, 18];

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

export function RunsRhythm({ runs, timeZone }: RunsRhythmProps) {
  const grid = rhythmGrid(runs, timeZone);
  const [cell, setCell] = useState<{ d: number; h: number } | null>(null);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      setCell(null);
      return;
    }
    const current = cell ?? { d: 0, h: 9 };
    const moves: Record<string, { d: number; h: number }> = {
      ArrowRight: { d: current.d, h: Math.min(23, current.h + 1) },
      ArrowLeft: { d: current.d, h: Math.max(0, current.h - 1) },
      ArrowDown: { d: Math.min(6, current.d + 1), h: current.h },
      ArrowUp: { d: Math.max(0, current.d - 1), h: current.h },
      Home: { d: current.d, h: 0 },
      End: { d: current.d, h: 23 },
    };
    const next = moves[e.key];
    if (!next) return;
    e.preventDefault();
    setCell(cell === null ? current : next);
  }

  // The busiest cell, for the summary a screen reader hears first.
  let peak: { d: number; h: number; n: number } | null = null;
  for (const [d, row] of grid.cells.entries()) {
    for (const [h, n] of row.entries()) {
      if (n > 0 && (peak === null || n > peak.n)) peak = { d, h, n };
    }
  }
  const activeCount = cell ? (grid.cells[cell.d]?.[cell.h] ?? 0) : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <div className="grid w-7 shrink-0 grid-rows-7 gap-[2px] text-[10px] leading-none text-[var(--color-content-tertiary)]" aria-hidden>
          {WEEKDAYS.map((d) => (
            <span key={d} className="flex items-center">
              {d}
            </span>
          ))}
        </div>
        <div
          role="img"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setCell(null)}
          aria-label={
            peak
              ? `${grid.total} runs. Busiest: ${WEEKDAYS[peak.d]} at ${hourLabel(peak.h)} with ${peak.n}. Use the arrow keys to read each hour.`
              : 'No runs in this window.'
          }
          className="grid min-w-0 flex-1 grid-cols-[repeat(24,minmax(0,1fr))] grid-rows-7 gap-[2px] rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        >
          {grid.cells.map((row, d) =>
            row.map((n, h) => {
              const isActive = cell?.d === d && cell?.h === h;
              // Opacity floor so a single run is visible against an empty cell.
              const opacity = n === 0 ? 0 : 0.2 + 0.8 * (n / Math.max(1, grid.max));
              return (
                <div
                  key={`${d}-${h}`}
                  className={`aspect-square rounded-[2px] bg-[var(--color-bg-elevated)] ${isActive ? 'ring-1 ring-[var(--color-content-primary)]' : ''}`}
                  onPointerEnter={(e) => {
                    if (e.pointerType !== 'touch') setCell({ d, h });
                  }}
                  onPointerLeave={(e) => {
                    if (e.pointerType !== 'touch') setCell((c) => (c?.d === d && c?.h === h ? null : c));
                  }}
                  onClick={() => setCell((c) => (c?.d === d && c?.h === h ? null : { d, h }))}
                >
                  <div className="size-full rounded-[2px] bg-[var(--color-accent)]" style={{ opacity }} />
                </div>
              );
            }),
          )}
        </div>
      </div>
      <div className="ml-9 grid grid-cols-4 text-[10px] tabular-nums text-[var(--color-content-tertiary)]" aria-hidden>
        {HOUR_TICKS.map((h) => (
          <span key={h}>{hourLabel(h)}</span>
        ))}
      </div>
      <p className="min-h-4 text-xs text-[var(--color-content-tertiary)]" aria-live="polite">
        {cell && activeCount !== null
          ? `${WEEKDAYS[cell.d]} ${hourLabel(cell.h)}–${hourLabel((cell.h + 1) % 24)}: ${activeCount} run${activeCount === 1 ? '' : 's'} started`
          : `Runs started, by your local weekday and hour (${timeZone}).`}
      </p>
    </div>
  );
}
