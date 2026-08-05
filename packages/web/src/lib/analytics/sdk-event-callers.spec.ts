import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

/**
 * Executable form of the invariant `analytics/track.ts` states in prose:
 * "**Do not add a third caller**" of the Dash0 Web SDK's `sendEvent`.
 *
 * A comment cannot fail a build, and this one guards something worth guarding —
 * every product event is supposed to be typed by `AnalyticsEvent` so renaming an
 * attribute or swapping vendors stays a single-file change. `lib/auth-telemetry.ts`
 * is the one deliberate exception (it needs a per-event `title` and `severity` that
 * `track`'s signature does not carry). A third caller added quietly would erode the
 * property before anyone noticed. This is the same shape as the repo's other
 * "make the stated invariant executable" guards — `audit-coverage.spec.ts`,
 * `tenant-scope-usage.spec.ts`, `edge-bare-specifier.spec.ts`.
 *
 * It anchors on the IMPORT, not on `sendEvent(` call sites: the string appears in
 * prose inside both docblocks, and the function cannot be called without being
 * imported, so the import is both the stricter and the less brittle signal.
 *
 * The assertion is set EQUALITY, not containment, so it also fires when an
 * allowlisted module stops importing `sendEvent` — at which point the prose in
 * `track.ts` has gone stale and must be edited alongside this list.
 */

const SRC_DIR = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Every module permitted to import `sendEvent`, relative to `packages/web/src`.
 * Adding an entry here is the visible edit that adding a caller must cost.
 */
const ALLOWED_SEND_EVENT_MODULES = ['lib/analytics/track.ts', 'lib/auth-telemetry.ts'];

/** Directories with no product code to scan. */
const SKIP_DIRS = new Set(['node_modules', '__screenshots__']);

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/** This file names the SDK and the symbol in prose; scanning it would match itself. */
const SELF = 'lib/analytics/sdk-event-callers.spec.ts';

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...sourceFiles(join(dir, entry.name)));
      continue;
    }
    if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
    const rel = relative(SRC_DIR, join(dir, entry.name));
    if (rel === SELF) continue;
    found.push(rel);
  }
  return found;
}

const SDK = String.raw`['"]@dash0/sdk-web['"]`;
const NAMED_IMPORT = new RegExp(String.raw`import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*${SDK}`, 'g');
const NAMESPACE_IMPORT = new RegExp(String.raw`import\s+\*\s+as\s+\w+\s+from\s*${SDK}`);

function importsSendEvent(source: string): boolean {
  for (const match of source.matchAll(NAMED_IMPORT)) {
    const bindings = (match[1] ?? '').split(',').map((binding) => binding.trim().split(/\s+/)[0]);
    if (bindings.includes('sendEvent')) return true;
  }
  return false;
}

const files = sourceFiles(SRC_DIR).map((path) => ({
  path,
  source: readFileSync(join(SRC_DIR, path), 'utf8'),
}));

describe('sendEvent callers', () => {
  // Anti-vacuity: a walker that silently returns nothing would make every
  // assertion below pass while checking no code at all.
  it('scans the web source tree', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((f) => f.path)).toContain('lib/analytics/track.ts');
  });

  it('is exactly the two modules track.ts documents', () => {
    const callers = files.filter((f) => importsSendEvent(f.source)).map((f) => f.path);
    expect(callers.sort()).toEqual([...ALLOWED_SEND_EVENT_MODULES].sort());
  });

  // A namespace import grants `sdk.sendEvent` without ever naming it, so it would
  // walk straight past the named-binding scan above.
  it('never reaches the SDK through a namespace import', () => {
    const namespaced = files.filter((f) => NAMESPACE_IMPORT.test(f.source)).map((f) => f.path);
    expect(namespaced).toEqual([]);
  });
});
