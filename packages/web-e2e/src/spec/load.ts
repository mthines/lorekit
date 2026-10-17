import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Spec } from './grammar.cjs';
import { parseSpecFile } from './grammar.cjs';

/** Every spec file in `dir`: `*.md`, except the format guide. Sorted, so test order is stable. */
export function listSpecFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort();
}

/** Parse every spec file in `dir`. Throws a SpecError naming `file:line` on the first bad line. */
export function loadSpecs(dir: string): Spec[] {
  return listSpecFiles(dir).flatMap((f) => parseSpecFile(readFileSync(path.join(dir, f), 'utf8'), `specs/${f}`));
}
