/**
 * What the Lore Graph says about itself, in words.
 *
 * A `<canvas>` is completely opaque to assistive technology — a screen reader
 * gets "graphic" and nothing else — so a WebGL view can never be the only way to
 * reach a memory. The map is therefore a SECOND view of the Explorer list, and
 * these are the sentences that keep it honest for a reader who cannot see it:
 * a live description of what is drawn, and an unmissable notice when a budget
 * clipped it.
 *
 * The copy lives here, pure and tested, rather than inline in JSX, for the same
 * reason the rest of `lore-graph` does: it is logic (pluralisation, which of
 * several truths to lead with) dressed as text, and logic in a template is
 * logic nobody tests.
 */

import type { LoreGraph } from './types';

/** English pluralisation for the two words this module needs. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

/**
 * The sentence announced to a screen reader when the map finishes settling.
 *
 * Leads with the counts because that is the thing the sighted reader gets for
 * free from the picture, and names the selection last because it is the part
 * that changes most often — a live region re-reads the whole string, and burying
 * the volatile part keeps the re-read recognisable.
 */
export function graphSummary(graph: LoreGraph, selectedLabel?: string | null): string {
  if (graph.nodes.length === 0) return 'No memories to map.';

  const memories = graph.nodes.filter((node) => node.kind === 'memory').length;
  const scopes = graph.nodes.filter((node) => node.kind === 'scope').length;
  const relations = graph.edges.filter((edge) => edge.kind !== 'scope').length;

  const parts = [
    `Map of ${count(memories, 'memory', 'memories')} across ${count(scopes, 'scope')}`,
    `${count(relations, 'relationship')} drawn`,
  ];
  if (selectedLabel) parts.push(`${selectedLabel} selected`);
  return `${parts.join(', ')}.`;
}

/**
 * The visible notice when a budget clipped the graph, or `null` when it did not.
 *
 * Deliberately says the numbers rather than "some results omitted": a reader
 * deciding whether the cluster they are looking at is the whole story needs to
 * know it is 2,000 of 5,000, and a vague hedge would leave them believing the
 * picture either more or less than it deserves.
 */
export function truncationNotice(graph: LoreGraph): string | null {
  const nodes = graph.truncated.find((entry) => entry.of === 'nodes');
  const edges = graph.truncated.find((entry) => entry.of === 'edges');
  if (!nodes && !edges) return null;

  const clauses: string[] = [];
  if (nodes) {
    clauses.push(
      `showing the ${nodes.kept.toLocaleString()} most recently updated of ${nodes.total.toLocaleString()} memories`,
    );
  }
  if (edges) {
    clauses.push(
      `the ${edges.kept.toLocaleString()} strongest of ${edges.total.toLocaleString()} relationships`,
    );
  }
  return `This map is capped for legibility — ${clauses.join(', and ')}.`;
}
