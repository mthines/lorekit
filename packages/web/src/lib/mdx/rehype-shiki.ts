import rehypeShiki from '@shikijs/rehype';
import type { RehypeShikiOptions } from '@shikijs/rehype';

// Derive the transformer type from the options rather than importing from `shiki`
// (a transitive dep we don't declare) — keeps the dependency surface minimal.
type ShikiTransformer = NonNullable<RehypeShikiOptions['transformers']>[number];

/** The single dark theme every code surface uses (the app is dark-only). */
export const SHIKI_THEME = 'github-dark-default';

/**
 * Shared Shiki syntax-highlighting config for every MDX surface (docs AND blog),
 * so both render code identically and can never drift.
 *
 * Highlighting happens at build/serialize time (server-side) — the compiled MDX
 * ships pre-coloured `<span>`s with zero client-side JS, which is exactly right
 * for our statically generated `/docs` and `/blog` routes. Shiki uses real
 * TextMate grammars, so the colours are accurate per language rather than a
 * regex approximation.
 *
 * The app is dark-only, so a single dark theme (`github-dark-default`) is all we
 * need. `fallbackLanguage: 'text'` means an unknown or missing fence language
 * degrades to plain (uncoloured) text instead of failing the build.
 */

/**
 * Strip Shiki's inline `background-color` from the `<pre>` so the block keeps the
 * app's `--color-bg-elevated` (set in `DocsProse`/`BlogProse`) — matching inline
 * code — while Shiki still colours the tokens. Keeping Shiki's own (near-black)
 * background would make fenced blocks a different shade from inline code.
 */
export const stripBackground: ShikiTransformer = {
  name: 'lorekit:strip-background',
  pre(node) {
    const style = node.properties['style'];
    if (typeof style === 'string') {
      const next = style.replace(/background-color:[^;]+;?/g, '').trim();
      node.properties['style'] = next.length > 0 ? next : undefined;
    }
  },
};

export const rehypeShikiOptions: RehypeShikiOptions = {
  theme: SHIKI_THEME,
  fallbackLanguage: 'text',
  transformers: [stripBackground],
};

export { rehypeShiki };
