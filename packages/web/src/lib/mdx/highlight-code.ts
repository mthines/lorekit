import 'server-only';
import { codeToHtml } from 'shiki';
import { SHIKI_THEME, stripBackground } from './rehype-shiki';

/**
 * Server-side syntax highlighting for code that ISN'T authored as MDX fenced
 * blocks — the bespoke snippets in `GettingStartedContent` (its `<pre>` blocks
 * and the `ClientConfigTabs` config snippets). The MDX pipeline's Shiki plugin
 * only sees fenced code, so those hand-rendered blocks need this.
 *
 * Uses the SAME theme + background-strip transformer as the MDX config
 * (`rehype-shiki.ts`), so highlighted code looks identical wherever it appears.
 * Runs at build/serialize time (server-only) — no Shiki ships to the client.
 * Returns `null` on any failure (e.g. an unknown language) so callers fall back
 * to plain text instead of breaking the render.
 */
export async function highlightToHtml(code: string, lang: string): Promise<string | null> {
  try {
    return await codeToHtml(code.trim(), {
      lang,
      theme: SHIKI_THEME,
      transformers: [stripBackground],
    });
  } catch {
    return null;
  }
}
