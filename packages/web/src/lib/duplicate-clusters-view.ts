/**
 * The Duplicate Clusters panel's pure half — identity, selection and labels.
 *
 * The panel itself (`components/lore/DuplicateClusters.tsx`) is a list-with-detail
 * surface over `GET /memories/clusters`, and every question that is *not* about
 * the DOM lives here, unit-tested, per this package's functional-core rule:
 *
 *  - **Identity.** A cluster has no server-side id — it is a transient grouping,
 *    recomputed on every request over a moving `updated_at desc` window. So the
 *    panel cannot hold "cluster 3" across a refetch; it holds a value derived
 *    from the MEMBERS ({@link clusterId}) and re-resolves it ({@link findCluster}).
 *  - **Selection totality.** Both selection steps must be total, because the data
 *    can change under a held selection: a cluster can dissolve (a lesson edited
 *    below the threshold), and a member can leave one. Every resolver here falls
 *    back rather than returning null-and-blank, so the panel has no "selected
 *    something that is gone" state to render.
 *  - **Honest labels.** Three facts about this endpoint are easy to render as
 *    something stronger than they are, and all three are shaped here so a
 *    component cannot get them wrong: the similarity RANGE is over the linking
 *    pairs and not a floor on every pair ({@link similarityLabel}), a recurrence
 *    class may be a PARTIAL match ({@link recurrenceLabel}), and an empty result
 *    over a SATURATED window is not the same claim as "you have no duplicates"
 *    ({@link windowSaturated}).
 *
 * Read-only throughout: nothing here decides that a cluster *should* be merged,
 * which is the boundary the whole feature keeps (see the route's own docblock).
 */

import type { ClusterMember, ClustersResponse, DuplicateCluster } from '@lorekit/schemas/memory';

/**
 * The panel opens COLLAPSED.
 *
 * Same call as `ExplorerInstruments`, for the same reason: the Explorer already
 * carries a scope strip, an Activity panel, an instrument panel and a filter bar
 * before the first memory, and a fourth always-open panel would push the list
 * the page exists for off a laptop screen. Duplicate clusters are also a
 * housekeeping question ("what have I written twice"), not the browsing question
 * the page opens on — so this is the panel that should cost a click, and the
 * choice persists once made.
 */
export const DEFAULT_CLUSTERS_OPEN = false;

/** `scope::key`, the natural key a member is addressed by everywhere else. */
export function memberLabel(member: Pick<ClusterMember, 'scope' | 'key'>): string {
  return `${member.scope}::${member.key}`;
}

/**
 * A stable-enough identity for a cluster, derived from its members.
 *
 * SORTED before joining, so the id does not depend on the order the ranking
 * happened to emit members in — otherwise a refetch that reordered members would
 * read as a different cluster and silently reset the reader's selection.
 *
 * It is deliberately NOT stable across membership changes: if a lesson joins or
 * leaves, this *is* a different grouping, and {@link findCluster} falls back to
 * the first cluster rather than pretending the old selection still means
 * something. That is the honest behaviour for a derived grouping with no server
 * id — the alternative (keying on the largest member, say) would silently
 * re-point a selection at a cluster the reader never chose.
 */
export function clusterId(cluster: Pick<DuplicateCluster, 'members'>): string {
  return (cluster.members ?? []).map(memberLabel).sort().join('|');
}

/**
 * Resolve a held cluster id against the current list.
 *
 * Total: an id that no longer resolves (or no id at all) selects the FIRST
 * cluster, which is the highest-ranked one — the same thing the panel shows
 * before anything is picked. An empty list yields `null`, which is the panel's
 * empty state rather than a selection failure.
 */
export function findCluster(
  clusters: readonly DuplicateCluster[] | undefined,
  id: string | null,
): DuplicateCluster | null {
  const list = clusters ?? [];
  if (list.length === 0) return null;
  if (id !== null) {
    const held = list.find((cluster) => clusterId(cluster) === id);
    if (held) return held;
  }
  return list[0] ?? null;
}

/**
 * Resolve a held member key against the selected cluster's members.
 *
 * Returns the INDEX, because prev/next is index arithmetic and the panel needs
 * both the position ("2 of 5") and the member. `-1` only when the cluster has no
 * members at all, which the schema's `size >= 2` makes unreachable from the
 * server — handled anyway so the panel has no crash path on a hand-built value.
 */
export function findMemberIndex(
  cluster: Pick<DuplicateCluster, 'members'> | null,
  label: string | null,
): number {
  const members = cluster?.members ?? [];
  if (members.length === 0) return -1;
  if (label !== null) {
    const at = members.findIndex((member) => memberLabel(member) === label);
    if (at !== -1) return at;
  }
  return 0;
}

/**
 * Step a member index by `delta`, CLAMPED to the ends.
 *
 * Clamped rather than wrapping: a cluster is a small set presented as a list
 * with a visible "3 of 5", and wrapping from the last member back to the first
 * under a "next" affordance reads as a jump, not a step. The panel disables the
 * buttons at the ends, and this function is what makes that safe to rely on —
 * a disabled button that was somehow activated still cannot move out of range.
 */
export function stepMemberIndex(index: number, total: number, delta: number): number {
  if (total <= 0) return -1;
  const next = index + delta;
  if (next < 0) return 0;
  if (next > total - 1) return total - 1;
  return next;
}

/** Round a 0–1 similarity to a whole percent. */
function percent(value: number): number {
  return Math.round(value * 100);
}

/**
 * How alike the cluster's members are, as prose.
 *
 * Collapses to a single figure when the range is one point wide after rounding —
 * "80–80% alike" is noise. The word is "alike" rather than "similar" or
 * "identical": these are Jaccard token overlaps, so 100% means *the same
 * vocabulary*, which is not the same claim as *the same text*.
 *
 * The caller must not present this as a floor on every pair in the cluster. The
 * range is measured over the pairs that LINKED the group, and clusters form
 * transitively — see `DuplicateClusterSchema.min_similarity`. The panel says
 * "linked at" for exactly that reason.
 */
export function similarityLabel(min: number, max: number): string {
  const lo = percent(min);
  const hi = percent(max);
  return lo === hi ? `${lo}% alike` : `${lo}–${hi}% alike`;
}

/** `2 lessons` / `5 lessons` — never a bare number, which reads as a count of clusters. */
export function sizeLabel(size: number): string {
  return `${size} lesson${size === 1 ? '' : 's'}`;
}

/**
 * The recurrence class to show for a cluster, or `null` when it resolved to none.
 *
 * `partial` is the load-bearing half: a class is reported when the MAJORITY of
 * members resolve to it, so presenting the name alone would claim the cluster
 * *is* that known recurrence when some members are something else. The schema
 * says a consumer MUST read `pure` before presenting the class as a complete
 * account; this is where that obligation is discharged once.
 */
export function recurrenceLabel(
  cluster: Pick<DuplicateCluster, 'recurrence_class' | 'size'>,
): { name: string; partial: boolean; matched: number } | null {
  const resolved = cluster.recurrence_class;
  if (!resolved) return null;
  return {
    name: resolved.name,
    partial: !resolved.pure,
    matched: resolved.matched.length,
  };
}

/**
 * Did the clustering run against a FULL candidate window?
 *
 * When it did, the answer is "what have I recently written that duplicates
 * something else recent" — not "these are all my duplicates". The panel has to
 * say so, because the two are indistinguishable from an empty `clusters` array
 * and only one of them is a clean bill of health. `lorekit dedupe` is the
 * whole-store answer, and the panel points at it.
 */
export function windowSaturated(
  response: Pick<ClustersResponse, 'candidates' | 'candidate_limit'> | undefined,
): boolean {
  if (!response) return false;
  return response.candidates >= response.candidate_limit;
}

/**
 * The collapsed header's summary.
 *
 * A disclosure that hides the answer is just hiding (the rule the Activity and
 * instrument panels both follow), so folded the panel still reports whether
 * there is anything to look at. Returns `null` while there is nothing to say
 * yet — before the first fetch resolves — so the header renders no placeholder
 * that could be mistaken for "none".
 */
export function clustersSummary(response: ClustersResponse | undefined): string | null {
  if (!response) return null;
  const clusters = response.clusters ?? [];
  if (clusters.length === 0) return 'None found';
  const lessons = clusters.reduce((total, cluster) => total + cluster.size, 0);
  return `${clusters.length} cluster${clusters.length === 1 ? '' : 's'} · ${sizeLabel(lessons)}`;
}
