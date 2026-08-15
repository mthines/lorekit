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
    id: 'give-your-agent-a-memory',
    label: 'Give your coding agent a memory in one command — no signup, just a folder',
    summary:
      "Your agent re-solves yesterday's problem because nothing wrote it down. The fix isn't a platform you adopt — it's one command, a folder you own, and a loop that closes on your own disk. And when a team needs the same lore, it's a free account and one install with your key: the same read path, handed a hosted store instead of a folder. Nothing to export, nothing to migrate.",
  },
  {
    id: 'agent-memory-working-set',
    label: "Your agent's memory should scale from 6 lessons to 60,000",
    summary:
      "The obvious answer to agent memory — inject the lessons — breaks the moment your store gets interesting. LoreKit spends a fixed slice of your context window on the highest-signal, de-duplicated lessons, so the read costs the same at 6 lessons or 60,000 — and always tells you what it left out. Here's how it scales, and the honest limits.",
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
