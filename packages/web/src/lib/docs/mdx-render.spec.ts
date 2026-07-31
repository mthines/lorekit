import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { serialize } from 'next-mdx-remote/serialize';
import { docsMdxOptions } from './mdx-render-options';

/**
 * Regression guard for the next-mdx-remote 6 `blockJS` default. With `blockJS`
 * left at its library default (`true`), JSX attribute *expressions* like
 * `<TutorialStep number={1}>` are stripped from the compiled output — string
 * attributes survive, so numbered-step badges would silently render empty. The
 * docs page renders through `docsMdxOptions`, which sets `blockJS: false`; this
 * test proves that choice actually preserves the `number` prop, and that the
 * hazard is real (so the guard can't pass vacuously).
 */

const DOCS_DIR = fileURLToPath(new URL('../../content/docs', import.meta.url));
const STEP_SNIPPET = '<TutorialStep number={1} title="Install the CLI">\n\nBody.\n\n</TutorialStep>';

describe('docs MDX render options (blockJS)', () => {
  it('preserves JSX attribute expressions (number={1}) with the shared options', async () => {
    const out = await serialize(STEP_SNIPPET, docsMdxOptions);
    expect(out.compiledSource).toMatch(/number/);
  });

  it('the library default (blockJS:true) would strip them — hazard is real', async () => {
    const out = await serialize(STEP_SNIPPET /* default blockJS: true */);
    expect(out.compiledSource).not.toMatch(/number/);
  });

  it('renders the real offline.mdx body with its numbered steps intact', async () => {
    const { content } = matter(readFileSync(`${DOCS_DIR}/offline.mdx`, 'utf8'));
    expect(content).toContain('number={'); // sanity: the source really uses expression attrs
    const out = await serialize(content, docsMdxOptions);
    expect(out.compiledSource).toMatch(/number/);
  });
});
