/**
 * Table-of-contents extraction — pure, dependency-free, and the SINGLE source of
 * heading-id truth for the blog.
 *
 * The scroll-spy sidebar and the rendered headings MUST agree on every `id`, or
 * the TOC links point at nothing. Rather than depend on `github-slugger`'s exact
 * algorithm (which leaves arrows/em-dashes in ids and never collapses the double
 * hyphens they create), the blog owns ONE {@link slugify}: this module builds the
 * TOC with it, and the blog's rehype plugin stamps heading ids with the same
 * function (see `mdx-render-options.ts`). Same function on both sides ⇒ zero drift
 * by construction.
 */

export interface TocItem {
  /** The heading's `id` — the fragment the sidebar link points at. */
  id: string;
  /** Plain-text heading label (inline markdown stripped). */
  text: string;
  /** Heading depth — 2 (`##`) or 3 (`###`). h1 is the page title, not a TOC entry. */
  depth: 2 | 3;
}

/**
 * Deterministic, self-consistent heading slug. Lowercase, drop everything that
 * is not a word char / space / hyphen (so apostrophes, em-dashes, arrows, colons
 * all vanish), collapse whitespace runs to a single hyphen, collapse repeated
 * hyphens, and trim. Pure — no clock, no randomness — so a heading always maps to
 * the same id across a server render and the client sidebar.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // strip punctuation/symbols; keep [A-Za-z0-9_], whitespace, hyphen
    .replace(/\s+/g, '-') // whitespace runs → one hyphen
    .replace(/-+/g, '-') // collapse repeated hyphens
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
}

/**
 * Reduce a heading's raw markdown to its rendered text: drop emphasis markers,
 * inline-code backticks, and link syntax (keeping the link label). Mirrors what
 * the rendered heading's `textContent` becomes, so {@link slugify} sees the same
 * input on both sides.
 */
function stripInlineMarkdown(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, '$1') // `code` → code
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url) → label
    .replace(/[*_~]/g, '') // emphasis markers
    .trim();
}

/**
 * Extract the `##` / `###` headings from an MDX body into an ordered TOC, with
 * ids stable against duplicate headings (a repeat gets `-1`, `-2`, …, exactly as
 * a slugger would). Fenced code blocks are skipped so a `#` shell comment or a
 * Markdown-in-a-fence example never becomes a phantom entry.
 */
export function extractToc(body: string): TocItem[] {
  const items: TocItem[] = [];
  const seen = new Map<string, number>();
  let inFence = false;

  for (const line of body.split('\n')) {
    // Toggle on ``` or ~~~ fences (with optional language/info string).
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;

    const depth = match[1].length as 2 | 3;
    const text = stripInlineMarkdown(match[2]);
    if (!text) continue;

    const base = slugify(text);
    // Dedupe: an empty slug (heading was all punctuation) still needs a handle.
    const key = base || 'section';
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    const id = count === 0 ? key : `${key}-${count}`;

    items.push({ id, text, depth });
  }

  return items;
}
