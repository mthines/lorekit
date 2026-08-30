import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MDX_SHIKI_LANGS } from './rehype-shiki';

/**
 * Regression guard for the `MDX_SHIKI_LANGS` allow-list.
 *
 * `rehypeShikiOptions.langs` intentionally restricts the shared Shiki
 * singleton to the languages our own MDX content uses (see the comment on
 * `MDX_SHIKI_LANGS`) instead of `@shikijs/rehype`'s default of loading every
 * bundled grammar (~200+) into the highlighter on first render — that default
 * is what caused a `web — elevated backend p95 latency` firing traced to
 * `/docs/[slug]` taking ~9s on a cold serverless instance.
 *
 * The trade-off: a fence language NOT in the list silently falls back to
 * plain, uncoloured text (`fallbackLanguage: 'text'`) rather than failing the
 * build — exactly the safety net that would hide a forgotten update to this
 * list. This spec closes that gap by scanning every real `.mdx` fence in both
 * `content/docs` and `content/blog` and asserting each language is covered.
 */

const DOCS_DIR = fileURLToPath(new URL('../../content/docs', import.meta.url));
const BLOG_DIR = fileURLToPath(new URL('../../content/blog', import.meta.url));

function fenceLanguagesIn(dir: string): Set<string> {
  const langs = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mdx'))) {
    const body = readFileSync(`${dir}/${file}`, 'utf8');
    for (const match of body.matchAll(/^```([a-zA-Z]+)/gm)) {
      const lang = match[1];
      if (lang) langs.add(lang.toLowerCase());
    }
  }
  return langs;
}

// `text` is `rehypeShikiOptions.fallbackLanguage`, not a loadable Shiki grammar
// (there is no `@shikijs/langs/text` module) — content fences it deliberately
// for plain, uncoloured output, so it is exempt from the "must be declared"
// check below.
const FALLBACK_LANGUAGE = 'text';

describe('MDX_SHIKI_LANGS covers every fence language in real content', () => {
  it('covers every docs + blog fence language', () => {
    const used = new Set([...fenceLanguagesIn(DOCS_DIR), ...fenceLanguagesIn(BLOG_DIR)]);
    // Sanity: the scan itself must find a non-trivial set, or this test would
    // pass vacuously if the glob/regex ever stopped matching real files.
    expect(used.size).toBeGreaterThan(0);

    const declared = new Set<string>(MDX_SHIKI_LANGS.map((l) => l.toLowerCase()));
    const missing = [...used].filter((lang) => lang !== FALLBACK_LANGUAGE && !declared.has(lang));
    expect(missing, `add these languages to MDX_SHIKI_LANGS: ${missing.join(', ')}`).toEqual([]);
  });
});
