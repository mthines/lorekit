/**
 * The blog table of contents — the single source of truth for which posts exist
 * and the order they appear in. Mirrors the docs `DOCS_SECTIONS` "registered
 * everywhere" invariant: adding a post means dropping a
 * `src/content/blog/<id>.mdx` file (with matching frontmatter) AND adding its
 * entry here. The drift guard `sections.spec.ts` fails if the two disagree.
 *
 * `id` is the URL slug and the MDX filename stem. Order here is the LISTING order
 * on `/blog` (newest first); the post's own `date` frontmatter is the displayed
 * date, and `order` frontmatter must agree with this array's index.
 */
export interface BlogSection {
  /** URL slug and MDX filename stem. */
  id: string;
  /** Post title — must match the MDX `title` frontmatter. */
  label: string;
  /** One-line summary — must match the MDX `description` frontmatter. */
  summary: string;
}

export const BLOG_SECTIONS: readonly BlogSection[] = [
  {
    id: 'agent-memory-working-set',
    label: "Your agent's memory is a ranked working set, not a dump",
    summary:
      "\"Cap it at 15\" was the wrong answer. LoreKit now spends a character budget on the highest-signal lessons — ranked by recurrence, de-duplicated with MMR, warmed by your branch, and never flooded by one bot — then tells you what it left out. Here's the read pipeline, and the honest limits.",
  },
  {
    id: 'self-healing-agents',
    label: 'Self-healing agents are just a loop you forgot to build',
    summary:
      "Self-healing and self-improving agents sound like an ML problem. They're not. It's a plain read-fail-write loop over shared memory — no fine-tuning, no new model call. Here's how LoreKit does it, guardrails and all.",
  },
];

/** URL slugs / MDX filename stems, in listing order (newest first). */
export const BLOG_SLUGS: readonly string[] = BLOG_SECTIONS.map((s) => s.id);
