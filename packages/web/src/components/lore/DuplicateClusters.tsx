'use client';

/**
 * DuplicateClusters — groups of near-duplicate lessons in the current scope,
 * ranked as merge candidates. READ-ONLY.
 *
 * ## What it is, and the boundary it keeps
 *
 * The compile pipeline's rule is "never auto-compile, never auto-gate": deciding
 * that N near-duplicate lessons are really one entry is a human judgment. So this
 * panel surfaces and ranks the evidence and stops. There is no merge button, no
 * delete, no "clean up" — not as a phase-one limitation but as the contract, the
 * same one `lorekit dedupe` and `lorekit invariants candidates` keep on the CLI
 * side and `GET /memories/clusters` keeps server-side.
 *
 * What it DOES do is get a reader from "these look duplicated" to the lessons
 * themselves in one click: every member opens in the Explorer's own
 * `LessonDetailSheet` through the existing `?lesson=` param, so the panel needs
 * no navigation of its own and adds no URL surface.
 *
 * ## Why it is a PANEL in the Explorer, not an instrument, and not /insights
 *
 * `lib/explorer-instruments.ts` defines the instrument contract in two halves.
 * This surface passes the first — click something and you end up holding lore,
 * which is what separates an Explorer surface from an `/insights` reading — and
 * fails the second: an instrument's every selection is written to the `?filters=`
 * bar, and "these five lessons are near-duplicates" is not a filter dimension
 * (it is a computed grouping over bodies, expressible in no pill). Forcing it
 * into the bar would mean inventing a dimension the API cannot filter on.
 *
 * So: Explorer yes, instrument no — its own collapsible panel, sibling to
 * `ExplorerInsights`/`ExplorerInstruments` and built to their shape. This
 * relitigates neither recorded decision: the filter menu keeps its monopoly on
 * filtering, and `/insights` keeps its monopoly on readings you cannot act on.
 *
 * ## It opens COLLAPSED, and that is load-bearing
 *
 * Unlike the two sibling panels, the disclosure here is not only about vertical
 * space: the query is `enabled` on it, so a folded panel issues NO clustering
 * request. The server read is quadratic in the worst case and fetches full
 * bodies, and duplicate-hunting is a housekeeping question — not something every
 * `/lore` page view should pay for. Expanding is the opt-in.
 *
 * The no-flash rule holds as it does elsewhere: until a client store has been
 * consulted the panel renders its NEUTRAL state (collapsed), which here coincides
 * with the default, so it is quiet on first paint.
 *
 * ## Three honest labels
 *
 * Everything a reader could over-read is shaped by the pure
 * `lib/duplicate-clusters-view.ts` so this component cannot get it wrong:
 *
 *  - the similarity range is over the pairs that LINKED the group, so the panel
 *    says "linked at 80–94% alike" rather than implying a floor on every pair;
 *  - a recurrence class can be a PARTIAL match, which is shown as such rather
 *    than as the cluster's name;
 *  - an empty result over a SATURATED candidate window is not a clean bill of
 *    health, so the panel says which question it answered and points at
 *    `lorekit dedupe` for the whole-store one.
 */

import { useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, CopyCheck, ExternalLink } from 'lucide-react';
import { motion, useReducedMotionConfig, AnimatePresence } from 'motion/react';
import { Badge } from '@/components/ui/Badge';
import { ScopeBadge } from '@/components/memory/ScopeBadge';
import { useDuplicateClusters } from '@/lib/queries/duplicate-clusters';
import { usePersistedPreference } from '@/lib/hooks/usePersistedPreference';
import {
  PREFERENCE_KEYS,
  isResolved,
  parseBooleanPreference,
  serializeBooleanPreference,
} from '@/lib/persisted-preference';
import { scopeType } from '@/lib/scope';
import {
  DEFAULT_CLUSTERS_OPEN,
  clusterId,
  clustersSummary,
  findCluster,
  findMemberIndex,
  memberLabel,
  recurrenceLabel,
  similarityLabel,
  sizeLabel,
  stepMemberIndex,
  windowSaturated,
} from '@/lib/duplicate-clusters-view';
import type { ClusterMember, DuplicateCluster } from '@lorekit/schemas/memory';

const PANEL_ID = 'explorer-clusters-body';

interface DuplicateClustersProps {
  /** The Explorer's selected scope, or `null` for every scope the viewer can see. */
  scope: string | null;
  /** Human label for the current scope, for the panel's captions. */
  scopeLabel: string;
  /** Opens a member in the Explorer's detail sheet. */
  onOpenLesson: (ref: { scope: string; key: string }) => void;
}

export function DuplicateClusters({ scope, scopeLabel, onOpenLesson }: DuplicateClustersProps) {
  const openPref = usePersistedPreference(PREFERENCE_KEYS.explorerClustersOpen);
  const resolved = isResolved(openPref.raw);
  const open = resolved && parseBooleanPreference(openPref.raw, DEFAULT_CLUSTERS_OPEN);

  // `useReducedMotionConfig`, not `useReducedMotion`: the latter ignores a
  // surrounding `MotionConfig`, which Storybook sets to collapse motion for
  // deterministic baselines — and this disclosure's exit gates an UNMOUNT.
  const reduceMotion = useReducedMotionConfig();

  // Folded means NOT FETCHED — see the docblock. This is the whole reason the
  // disclosure state reaches the query.
  const { data, isLoading, isError } = useDuplicateClusters({ scope, enabled: open });

  // Held as VALUES, not indices, and re-resolved every render by the pure
  // helpers: the underlying clusters are recomputed server-side over a moving
  // window, so an index would silently point at a different cluster after a
  // refetch.
  const [heldClusterId, setHeldClusterId] = useState<string | null>(null);
  const [heldMember, setHeldMember] = useState<string | null>(null);

  const clusters = data?.clusters ?? [];
  const selected = findCluster(clusters, heldClusterId);
  const memberIndex = findMemberIndex(selected, heldMember);
  const members = selected?.members ?? [];
  const member: ClusterMember | undefined = memberIndex >= 0 ? members[memberIndex] : undefined;

  const summary = clustersSummary(data);
  const saturated = windowSaturated(data);

  function selectCluster(cluster: DuplicateCluster) {
    setHeldClusterId(clusterId(cluster));
    // Reset to the cluster's first member — carrying a member selection across
    // clusters would land on "member 1" anyway (the labels do not resolve), so
    // clearing it says what happens instead of relying on the fallback.
    setHeldMember(null);
  }

  function stepMember(delta: number) {
    const next = stepMemberIndex(memberIndex, members.length, delta);
    const target = members[next];
    if (target) setHeldMember(memberLabel(target));
  }

  return (
    <section
      aria-label="Duplicate clusters"
      // `@container` for the sibling panels' reason: the body's two-column split
      // has to key off the PANEL's width, not the viewport's, so it behaves in a
      // squeezed column.
      className="@container rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <CopyCheck className="size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
        <h2 className="text-xs font-medium text-[var(--color-content-secondary)]">
          Duplicate clusters
        </h2>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* The collapsed state is not empty: never fold away the answer. It
              says nothing at all before the first fetch resolves, because
              "None found" is the reassuring direction and the panel has not
              earned it yet. */}
          {summary !== null && (
            <span className="hidden text-[10px] text-[var(--color-content-tertiary)] @sm:inline">
              {summary}
            </span>
          )}
          <button
            type="button"
            onClick={() => openPref.write(serializeBooleanPreference(!open))}
            aria-expanded={open}
            // Only reference the region while it EXISTS — it is unmounted when
            // collapsed, so a static IDREF would dangle in exactly that state.
            {...(open ? { 'aria-controls': PANEL_ID } : {})}
            aria-label={open ? 'Hide duplicate clusters' : 'Show duplicate clusters'}
            className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-content-secondary)]"
          >
            <motion.span
              animate={{ rotate: open ? 180 : 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.15 }}
              className="flex"
            >
              <ChevronDown className="size-4" aria-hidden />
            </motion.span>
          </button>
        </div>
      </div>

      {/* Mounted only once the stored preference is known, so the first
          application of it is an instant swap rather than an animated unfold. */}
      {resolved && (
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              id={PANEL_ID}
              key="clusters"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeOut' }}
              style={{ overflow: 'hidden' }}
            >
              <div className="flex flex-col gap-3 border-t border-[var(--color-border)] px-4 pb-4 pt-4">
                {isLoading ? (
                  <div className="flex flex-col gap-2" aria-hidden>
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="h-12 animate-pulse rounded-lg bg-[var(--color-bg-elevated)]" />
                    ))}
                  </div>
                ) : isError ? (
                  // NEVER fold a failed request into the empty state: "no
                  // duplicates" is the reassuring reading, and rendering it for a
                  // broken panel hides the defect completely (the failure mode
                  // HotColdLore's own comment records).
                  <p className="text-xs text-[var(--color-content-secondary)]">
                    Failed to load duplicate clusters. Please refresh the page to try again.
                  </p>
                ) : clusters.length === 0 ? (
                  <p className="text-xs text-[var(--color-content-tertiary)]">
                    No near-duplicate lessons in {scopeLabel}
                    {saturated ? ' among the most recently written ones' : ''}.
                  </p>
                ) : (
                  <div className="grid gap-3 @2xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
                    {/* ── The clusters ─────────────────────────────────────
                        A radiogroup rather than a list of links: picking one
                        changes what the detail pane shows and navigates
                        nowhere. */}
                    {/* A `radiogroup` of buttons rather than a `ul` of links:
                        these are OPTIONS (picking one changes what the pane
                        beside it shows and navigates nowhere), and a list of
                        list-items carrying `role="none"` would be two
                        semantics fighting. */}
                    <div
                      role="radiogroup"
                      aria-label="Duplicate clusters"
                      className="flex max-h-72 flex-col gap-1.5 overflow-y-auto"
                    >
                      {clusters.map((cluster) => {
                        const id = clusterId(cluster);
                        const isSelected = selected !== null && clusterId(selected) === id;
                        const recurrence = recurrenceLabel(cluster);
                        return (
                          <button
                            key={id}
                            type="button"
                            role="radio"
                            aria-checked={isSelected}
                            onClick={() => selectCluster(cluster)}
                            className={[
                              'flex w-full flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left text-xs transition-colors duration-150',
                              isSelected
                                ? 'border-[var(--color-accent)] bg-[var(--color-bg-elevated)]'
                                : 'border-[var(--color-border)] bg-[var(--color-bg-elevated)] hover:border-[var(--color-content-tertiary)]',
                            ].join(' ')}
                          >
                            <span className="flex w-full items-center gap-2">
                              <span className="font-medium text-[var(--color-content-primary)]">
                                {sizeLabel(cluster.size)}
                              </span>
                              <span className="ml-auto font-mono text-[10px] text-[var(--color-content-tertiary)]">
                                linked at {similarityLabel(cluster.min_similarity, cluster.max_similarity)}
                              </span>
                            </span>
                            {recurrence && (
                              <span className="flex flex-wrap items-center gap-1">
                                <Badge variant={recurrence.partial ? 'amber' : 'purple'}>
                                  {recurrence.name}
                                </Badge>
                                {recurrence.partial && (
                                  <span className="text-[10px] text-[var(--color-content-tertiary)]">
                                    partial · {recurrence.matched} of {cluster.size} match
                                  </span>
                                )}
                              </span>
                            )}
                            <span className="w-full truncate font-mono text-[10px] text-[var(--color-content-tertiary)]">
                              {cluster.members.map((m) => m.key).join(', ')}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* ── The selected cluster's members ───────────────────
                        List AND stepper, because the two answer different
                        questions: the list is "what is in here", the stepper is
                        "read these one after another". */}
                    {selected && (
                      <div className="flex min-w-0 flex-col gap-2">
                        <div
                          role="radiogroup"
                          aria-label="Lessons in the selected cluster"
                          className="flex flex-col gap-1"
                        >
                          {members.map((m, i) => (
                            <button
                              key={memberLabel(m)}
                              type="button"
                              role="radio"
                              aria-checked={i === memberIndex}
                              onClick={() => setHeldMember(memberLabel(m))}
                              className={[
                                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors duration-150',
                                i === memberIndex
                                  ? 'bg-[var(--color-bg-elevated)] text-[var(--color-content-primary)]'
                                  : 'text-[var(--color-content-secondary)] hover:bg-[var(--color-bg-elevated)]',
                              ].join(' ')}
                            >
                              <ScopeBadge
                                scope={m.scope}
                                type={scopeType(m.scope)}
                                showType={false}
                                label
                                className="shrink-0"
                              />
                              <code className="min-w-0 flex-1 truncate font-mono">{m.key}</code>
                              {m.seen_count != null && (
                                <span className="shrink-0 font-mono text-[10px] text-[var(--color-content-tertiary)]">
                                  written {m.seen_count}×
                                </span>
                              )}
                            </button>
                          ))}
                        </div>

                        {member && (
                          <div
                            // Polite, because prev/next replaces the content of a
                            // region the reader is not focused inside — without it
                            // stepping is silent to a screen reader.
                            aria-live="polite"
                            className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3"
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[10px] text-[var(--color-content-tertiary)]">
                                {memberIndex + 1} of {members.length}
                              </span>
                              {member.status && (
                                <Badge variant="default" title="Status declared by the lesson itself">
                                  {member.status}
                                </Badge>
                              )}
                              <div className="ml-auto flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => stepMember(-1)}
                                  disabled={memberIndex <= 0}
                                  aria-label="Previous lesson in this cluster"
                                  className="flex min-h-6 min-w-6 items-center justify-center rounded-md text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-content-secondary)] disabled:opacity-40 disabled:hover:text-[var(--color-content-tertiary)]"
                                >
                                  <ChevronLeft className="size-4" aria-hidden />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => stepMember(1)}
                                  disabled={memberIndex >= members.length - 1}
                                  aria-label="Next lesson in this cluster"
                                  className="flex min-h-6 min-w-6 items-center justify-center rounded-md text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-content-secondary)] disabled:opacity-40 disabled:hover:text-[var(--color-content-tertiary)]"
                                >
                                  <ChevronRight className="size-4" aria-hidden />
                                </button>
                              </div>
                            </div>

                            <p className="text-xs text-[var(--color-content-secondary)]">{member.hook}</p>

                            <div className="flex items-center gap-2">
                              <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-content-tertiary)]">
                                {memberLabel(member)}
                              </code>
                              <button
                                type="button"
                                onClick={() => onOpenLesson({ scope: member.scope, key: member.key })}
                                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-2.5 py-1.5 text-xs text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)]"
                              >
                                <ExternalLink className="size-3.5" aria-hidden />
                                Open lesson
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* The two things a reader must not have to infer: this panel
                    never changes anything, and it answered a WINDOWED question
                    when the candidate window was full. */}
                {data && !isError && (
                  <p className="text-[10px] leading-relaxed text-[var(--color-content-tertiary)]">
                    Read-only — nothing here merges, edits or deletes lore.{' '}
                    {saturated ? (
                      <>
                        Clustered over the {data.candidate_limit} most recently updated lessons in{' '}
                        {scopeLabel} — recent duplicates only. Run{' '}
                        <code className="font-mono text-[var(--color-content-secondary)]">
                          lorekit dedupe
                        </code>{' '}
                        for the whole store.
                      </>
                    ) : (
                      <>
                        Clustered over all {data.candidates} active lessons in {scopeLabel}.
                      </>
                    )}
                  </p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </section>
  );
}
