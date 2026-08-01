import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { slugify, extractToc } from './toc';

describe('slugify', () => {
  it('lowercases and hyphenates plain headings', () => {
    expect(slugify('Your agent has amnesia')).toBe('your-agent-has-amnesia');
    expect(slugify('Memory has a gradient')).toBe('memory-has-a-gradient');
  });

  it('drops apostrophes, em-dashes, arrows and colons without leaving double hyphens', () => {
    expect(slugify("Self-healing isn't magic — it's read → fail → write")).toBe(
      'self-healing-isnt-magic-its-read-fail-write',
    );
    expect(slugify("What it doesn't do")).toBe('what-it-doesnt-do');
    expect(slugify('The dangerous part: not entrenching your own mistakes')).toBe(
      'the-dangerous-part-not-entrenching-your-own-mistakes',
    );
  });

  it('collapses whitespace runs and trims edge hyphens', () => {
    expect(slugify('  spaced   out  ')).toBe('spaced-out');
    expect(slugify('— leading symbol')).toBe('leading-symbol');
  });
});

describe('extractToc', () => {
  it('extracts h2 and h3 with depth and slug id', () => {
    const toc = extractToc(['## First section', 'body', '### A detail', '## Second'].join('\n'));
    expect(toc).toEqual([
      { id: 'first-section', text: 'First section', depth: 2 },
      { id: 'a-detail', text: 'A detail', depth: 3 },
      { id: 'second', text: 'Second', depth: 2 },
    ]);
  });

  it('ignores h1 (the page title) and headings inside fenced code blocks', () => {
    const body = [
      '# Page title',
      '## Real heading',
      '```bash',
      '# not a heading, a shell comment',
      '## also not a heading',
      '```',
      '## Another real heading',
    ].join('\n');
    const toc = extractToc(body);
    expect(toc.map((t) => t.text)).toEqual(['Real heading', 'Another real heading']);
  });

  it('strips inline markdown from heading text before slugging', () => {
    const toc = extractToc('## The `memory.write` **call**');
    expect(toc[0]).toEqual({ id: 'the-memorywrite-call', text: 'The memory.write call', depth: 2 });
  });

  it('dedupes repeated headings with numeric suffixes', () => {
    const toc = extractToc(['## Setup', '## Setup', '## Setup'].join('\n'));
    expect(toc.map((t) => t.id)).toEqual(['setup', 'setup-1', 'setup-2']);
  });
});

describe('the shipped post is self-consistent', () => {
  const body = matter(
    readFileSync(fileURLToPath(new URL('../../content/blog/self-healing-agents.mdx', import.meta.url)), 'utf8'),
  ).content;
  const toc = extractToc(body);

  it('produces several unique, non-empty heading ids', () => {
    expect(toc.length).toBeGreaterThanOrEqual(5);
    const ids = toc.map((t) => t.id);
    expect(new Set(ids).size, 'ids must be unique').toBe(ids.length);
    for (const t of toc) {
      expect(t.id.length, `${t.text}: empty id`).toBeGreaterThan(0);
      expect([2, 3]).toContain(t.depth);
    }
  });

  it('does not capture shell comments from the fenced install block', () => {
    const texts = toc.map((t) => t.text.toLowerCase());
    expect(texts.some((t) => t.includes('scaffolds') || t.includes('confirm the loop'))).toBe(false);
  });
});
