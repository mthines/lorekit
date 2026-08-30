import rehypeShiki from '@shikijs/rehype';
import type { RehypeShikiOptions } from '@shikijs/rehype';

// Derive the transformer type from the options rather than importing `ShikiTransformer`
// from `shiki` directly, so it always matches whichever `shiki` version
// `@shikijs/rehype` resolves — even if that differs from our own declared one.
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
 * Fence languages actually used across `src/content/docs/*.mdx` and
 * `src/content/blog/*.mdx` (kept in sync by `rehype-shiki.spec.ts`, which
 * scans every real `.mdx` fence and fails if one uses a language missing
 * here — the fallback is silent, so drift would otherwise ship uncoloured
 * code with no test signal).
 *
 * **Load-bearing perf fix.** `@shikijs/rehype`'s default export loads
 * `Object.keys(bundledLanguages)` — all ~200+ Shiki-bundled grammars — into
 * its shared singleton highlighter whenever `options.langs` is omitted (see
 * `@shikijs/rehype`'s `index.ts`: `const langs = options.langs ||
 * Object.keys(bundledLanguages)`). That singleton is created once per
 * serverless instance and reused after, so *most* requests are cheap, but the
 * page that happens to be first to render on a cold instance pays the full
 * ~9s cost of compiling every bundled grammar (confirmed against production
 * traces: a `web — elevated backend p95 latency` firing traced to
 * `/docs/[slug]` — `prerender route (app) /docs/[slug]` — with no work
 * attributable to any child span, i.e. time spent inside Shiki's first call).
 * Declaring the handful of languages our content actually uses makes that
 * one-time cost proportional to ~6 grammars instead of ~200+.
 *
 * Add a language here the moment a new `.mdx` fence needs it — the render
 * specs catch an addition that forgets to (`docs/mdx-render.spec.ts`,
 * `blog/mdx-render.spec.ts`).
 */
export const MDX_SHIKI_LANGS = ['bash', 'json', 'jsonc', 'yaml', 'javascript', 'js'] as const;

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
  langs: [...MDX_SHIKI_LANGS],
  fallbackLanguage: 'text',
  transformers: [stripBackground],
};

export { rehypeShiki };
