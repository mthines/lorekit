/**
 * Generate `packages/web/public/llms.txt`.
 *
 * The I/O shell around the pure `render.ts` — the same split, and the same
 * write-outside-the-package precedent, as `openapi/generate.ts`.
 *
 * Usage:
 *   node --experimental-transform-types packages/schemas/src/llms/generate.ts
 *   node --experimental-transform-types packages/schemas/src/llms/generate.ts --check
 *
 * Runs on a bare checkout with no `node_modules`: it reads the zero-dependency
 * tool catalog and a handful of markdown files, so it must never grow a `zod`
 * (or any other runtime) import.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderLlmsTxt, type DocsIndexEntry } from './render.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../..');

export const TEMPLATE_PATH = join(here, 'template.md');
export const DOCS_CONTENT_DIR = join(repoRoot, 'packages/web/src/content/docs');
export const OUTPUT_PATH = join(repoRoot, 'packages/web/public/llms.txt');

/**
 * Pull `title` / `description` / `order` out of an MDX frontmatter block.
 *
 * A deliberately small parser rather than a YAML dependency: the frontmatter
 * in `content/docs` is a flat set of quoted scalars, and `sections.spec.ts`
 * already fails the build if a page ships without them. Anything it cannot
 * read is reported by the caller instead of being silently skipped.
 */
export function parseFrontmatter(source: string): Partial<Record<'title' | 'description' | 'order', string>> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) return {};

  const out: Record<string, string> = {};
  for (const line of (match[1] as string).split(/\r?\n/)) {
    const field = /^(title|description|order):\s*(.*)$/.exec(line);
    if (!field) continue;
    out[field[1] as string] = (field[2] as string).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Read every docs MDX page into an index entry, ordered by `order`. */
export function readDocsIndex(dir: string = DOCS_CONTENT_DIR): DocsIndexEntry[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.mdx'));
  const entries: DocsIndexEntry[] = [];
  const bad: string[] = [];

  for (const file of files.sort()) {
    const slug = basename(file, '.mdx');
    const { title, description, order } = parseFrontmatter(readFileSync(join(dir, file), 'utf8'));
    if (!title || !description || order === undefined) {
      bad.push(file);
      continue;
    }
    entries.push({ slug, title, description, order: Number(order) });
  }

  if (bad.length) {
    throw new Error(
      `Docs page(s) missing title/description/order frontmatter: ${bad.join(', ')}. ` +
        'llms.txt indexes every page, so these fields are required.',
    );
  }
  return entries;
}

/** The exact content `llms.txt` should have right now. */
export function buildLlmsTxt(): string {
  return renderLlmsTxt({
    template: readFileSync(TEMPLATE_PATH, 'utf8'),
    docs: readDocsIndex(),
  });
}

function main(): void {
  const check = process.argv.includes('--check');
  const expected = buildLlmsTxt();

  if (check) {
    let actual: string | null = null;
    try {
      actual = readFileSync(OUTPUT_PATH, 'utf8');
    } catch {
      actual = null;
    }
    if (actual !== expected) {
      console.error(
        'packages/web/public/llms.txt is stale.\n' +
          'Run: pnpm nx generate:llms schemas\n' +
          '(Edit packages/schemas/src/llms/template.md or src/tool-catalog.ts — never llms.txt itself.)',
      );
      process.exit(1);
    }
    console.log('llms.txt is in sync.');
    return;
  }

  writeFileSync(OUTPUT_PATH, expected);
  console.log('llms.txt written to', OUTPUT_PATH);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
