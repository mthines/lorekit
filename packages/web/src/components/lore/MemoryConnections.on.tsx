'use client';

/**
 * The lesson drawer's "Connections" section — the `memory-graph` ON arm.
 *
 * Collapsed by default, and it fetches only once opened (`enabled` is the
 * disclosure), so a reader who never looks costs the server nothing. Shows what
 * `GET /memories/:id/neighbours` knows about one lesson: lessons credited in the
 * same run, the retrospectives that credited it, its supersede chain, its
 * near-duplicates, and the runs it was credited in.
 *
 * An empty section is information, not a failure: edges come from agents citing
 * lessons (`cited` on `memory.write`) and from lineage, so a lesson nobody has
 * credited has none. The empty state says so and says how to get some.
 */

import { useState } from 'react';
import { ChevronDown, Network } from 'lucide-react';
import { useMemorySidebar } from '@/components/providers/MemorySidebarProvider';
import { useMemoryNeighbours } from '@/lib/queries/memory-graph';
import { EDGE_KIND_LABEL, EDGE_KIND_ORDER } from '@/lib/memory-graph-layout';
import { MemoryEgoGraph, EDGE_KIND_STROKE } from './MemoryEgoGraph';
import type { LessonEntry } from './LessonCard';
import type { MemoryNeighbour } from '@lorekit/schemas/memory';

export interface MemoryConnectionsProps {
  lesson: LessonEntry;
}

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function MemoryConnectionsOn({ lesson }: MemoryConnectionsProps) {
  const [open, setOpen] = useState(false);
  const { openLessonById } = useMemorySidebar();
  // A lesson without a row id (a legacy client fetch) cannot be queried.
  const id = lesson.id ?? null;
  const query = useMemoryNeighbours(id, open);
  if (!id) return null;

  const neighbours = query.data?.neighbours ?? [];
  const runs = query.data?.runs ?? [];
  const total = neighbours.length;

  function openNeighbour(n: MemoryNeighbour) {
    openLessonById({ scope: n.scope, key: n.key }, undefined, { surface: 'lore-connection' });
  }

  const byKind = EDGE_KIND_ORDER.map((kind) => ({ kind, items: neighbours.filter((n) => n.kind === kind) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <section aria-label="Connections" className="mt-6">
      <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="lesson-connections-body"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 rounded text-left uppercase tracking-wide outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          <Network className="size-3.5" aria-hidden />
          Connections
          {open && query.data && (
            <span className="rounded-full bg-[var(--color-bg-elevated)] px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-[var(--color-content-secondary)]">
              {total}
            </span>
          )}
          <ChevronDown className={`ml-auto size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </button>
      </h2>

      {open && (
        <div id="lesson-connections-body" className="mt-3 flex flex-col gap-4">
          {query.isLoading ? (
            <div className="h-40 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)]" aria-hidden />
          ) : query.isError ? (
            <p role="alert" className="text-xs text-[var(--color-error)]">
              Could not load this lesson&rsquo;s connections. Close and reopen the section to try again.
            </p>
          ) : total === 0 && runs.length === 0 ? (
            <p className="text-xs text-[var(--color-content-tertiary)]">
              No connections yet. A lesson gets connections when an agent credits it together with others in a run
              (the <code className="font-mono">cited</code> list on <code className="font-mono">memory.write</code>),
              when it replaces or is replaced by another lesson, or when another lesson says nearly the same thing.
            </p>
          ) : (
            <>
              {total > 0 && <MemoryEgoGraph focusKey={lesson.key} neighbours={neighbours} onOpen={openNeighbour} />}

              {byKind.length > 0 && (
                <div className="flex flex-col gap-3">
                  {byKind.map(({ kind, items }) => (
                    <div key={kind}>
                      <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[var(--color-content-secondary)]">
                        <span
                          aria-hidden
                          className="inline-block size-2 rounded-full border-2"
                          style={{ borderColor: EDGE_KIND_STROKE[kind] }}
                        />
                        {EDGE_KIND_LABEL[kind]}
                      </h3>
                      <ul className="flex flex-col">
                        {items.map((n) => (
                          <li key={`${kind}-${n.id}`}>
                            <button
                              type="button"
                              onClick={() => openNeighbour(n)}
                              className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left text-xs outline-none hover:bg-[var(--color-bg-elevated)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                            >
                              <span className="truncate font-mono text-[var(--color-content-primary)]">{n.key}</span>
                              <span className="ml-auto shrink-0 text-[var(--color-content-tertiary)]">
                                {kind === 'co_cited'
                                  ? `${n.weight}×`
                                  : kind === 'duplicate'
                                    ? `${n.weight}%`
                                    : ''}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}

              {runs.length > 0 && (
                <div>
                  <h3 className="mb-1 text-[11px] font-medium text-[var(--color-content-secondary)]">
                    Credited in {runs.length} {runs.length === 1 ? 'run' : 'runs'}
                  </h3>
                  <ul className="flex flex-col gap-0.5 text-xs">
                    {runs.map((r) => (
                      <li key={r.correlation_id} className="flex items-baseline gap-2 px-1.5 py-0.5">
                        <span className="truncate font-mono text-[var(--color-content-primary)]" title={r.correlation_id}>
                          {r.correlation_id}
                        </span>
                        {r.session_kind && (
                          <span className="shrink-0 rounded bg-[var(--color-bg-elevated)] px-1 text-[10px] text-[var(--color-content-secondary)]">
                            {r.session_kind}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 text-[var(--color-content-tertiary)]">{formatWhen(r.last_at)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
