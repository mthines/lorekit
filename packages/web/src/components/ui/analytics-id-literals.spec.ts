import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

/**
 * Executable form of the invariant `ui.button_click` depends on: a Button's
 * `analyticsId` MUST be a STATIC string literal, never `analyticsId={expr}`.
 *
 * This covers the whole `*AnalyticsId=` family of JSX attributes, not just the
 * bare `analyticsId=` on Button. A wrapper primitive that re-exposes the id
 * under a distinct prop name (`confirmAnalyticsId=` on `ConfirmDialog`, and any
 * future `*AnalyticsId`) is a CALL SITE too — the cardinality/PII risk lives
 * wherever a developer supplies the value — so the same literal rule applies.
 *
 * The whole event's value hinges on `buttonId` staying a bounded, developer
 * authored `<surface>.<action>` slug — the same discipline `normalizeCommandId`
 * enforces for command ids. An interpolated `analyticsId={user.name}` or
 * `analyticsId={`row-${id}`}` would leak user content and explode the attribute
 * cardinality, and a comment in `track.ts` cannot fail a build. This is the same
 * shape as the repo's other "make the stated invariant executable" scans —
 * `sdk-event-callers.spec.ts`, `audit-coverage.spec.ts`.
 *
 * The forwarding primitives themselves (`FORWARDING_FILES`) are exempt from the
 * literal rule: they receive a typed `analyticsId?: string` prop and forward it
 * onward, so the value they pass is a variable by design. Enforcing literals at
 * their CALL SITES — where the cardinality/PII risk actually lives — is what
 * keeps the guarantee intact while letting the wrappers forward honestly.
 */

const SRC_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Directories with no product code to scan. */
const SKIP_DIRS = new Set(['node_modules', '__screenshots__']);

const SOURCE_EXTENSIONS = ['.tsx'];

/** This file names the illegal `analyticsId={` form in prose; scanning it would match itself. */
const SELF = 'components/ui/analytics-id-literals.spec.ts';

/**
 * Forwarding primitives — they take a typed `analyticsId?: string` prop and pass
 * it through, so their forward is a variable by design (`analyticsId={confirmId}`,
 * `analyticsId={action.analyticsId ?? '…'}`). They are exempt from the literal
 * rule but still count toward the anti-vacuity total; the literal guarantee is
 * enforced at their CALL SITES, where the cardinality/PII risk lives.
 */
const FORWARDING_FILES = new Set([
  'components/ui/Button.tsx',
  'components/ui/ConfirmDialog.tsx',
  'components/ui/EmptyState.tsx',
]);

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

/**
 * Every `*AnalyticsId=` JSX attribute in the family (`analyticsId=`,
 * `confirmAnalyticsId=`, any future `<prefix>AnalyticsId=`), with the character
 * that opens its value — so a distinct-prop wrapper call site is guarded too.
 */
const USAGE = /\b[A-Za-z]*[Aa]nalyticsId\s*=\s*(.)/g;

const files = sourceFiles(SRC_DIR).map((path) => ({
  path,
  source: readFileSync(join(SRC_DIR, path), 'utf8'),
}));

function usages(source: string): string[] {
  const opens: string[] = [];
  for (const match of source.matchAll(USAGE)) opens.push(match[1] ?? '');
  return opens;
}

describe('analyticsId literals', () => {
  // Anti-vacuity: a scan that found nothing would pass the literal assertion
  // while checking no adoption at all.
  it('finds the adopted analyticsId usages across the source tree', () => {
    const total = files.reduce((sum, f) => sum + usages(f.source).length, 0);
    expect(total).toBeGreaterThan(50);
  });

  it('is always a string literal at every call site, never an interpolated expression', () => {
    const offenders = files
      .filter((f) => !FORWARDING_FILES.has(f.path))
      .filter((f) => usages(f.source).some((open) => open !== '"' && open !== "'"))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
