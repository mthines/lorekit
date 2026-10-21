'use client';

/**
 * RunsPanel — the runs rhythm and swimlanes, with their own paginated fetch.
 *
 * Its own component so the page can mount it only once the Runs section is
 * near the viewport (`use-in-view.ts`): `useWindowRuns` reads up to five pages,
 * and none of it is visible on load.
 */

import { useWindowRuns, MAX_RUN_PAGES } from '@/lib/queries/insights-loop';
import type { AbsoluteRange } from '@/lib/time-range';
import { RunsRhythm } from './RunsRhythm';
import { RunsSwimlanes } from './RunsSwimlanes';

interface RunsPanelProps {
  window: AbsoluteRange;
  rangeCaption: string;
  timeZone: string;
}

const NOTICE =
  'rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 text-xs text-[var(--color-content-tertiary)]';

export function RunsPanel({ window, rangeCaption, timeZone }: RunsPanelProps) {
  const runs = useWindowRuns(window);
  const data = runs.data;

  if (runs.isLoading) {
    return (
      <div
        className="h-40 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
        aria-hidden
      />
    );
  }
  if (runs.isError) return <p className={NOTICE}>Failed to load runs. Please refresh the page to try again.</p>;
  if (!data || data.runs.length === 0) return <p className={NOTICE}>No runs recorded in {rangeCaption}.</p>;

  return (
    <div
      className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 transition-opacity duration-200 ${runs.isPlaceholderData ? 'opacity-60' : ''}`}
      aria-busy={runs.isPlaceholderData || undefined}
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <RunsRhythm runs={data.runs} timeZone={timeZone} />
        {/* Drawn on the window these runs were fetched for, not the newly selected one. */}
        <RunsSwimlanes runs={data.runs} window={data.window} timeZone={timeZone} />
      </div>
      {data.truncated && (
        <p className="mt-3 text-xs text-[var(--color-content-tertiary)]">
          Showing the {data.runs.length.toLocaleString('en-US')} most recent runs ({MAX_RUN_PAGES} pages), so the start
          of the window may look emptier than it was — pick a shorter range to see them all.
        </p>
      )}
    </div>
  );
}
