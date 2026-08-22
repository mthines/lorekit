import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AUDIT_ACTIONS } from '@lorekit/schemas';

/**
 * Drift guard for the `audit_log.action` vocabulary.
 *
 * THE BUG THIS WOULD HAVE CAUGHT. The action list existed in three
 * independent places that had silently diverged:
 *
 *   - the TS writers            11 actions
 *   - the SQL CHECK             23 actions (00027_audit_log_scope_actions.sql)
 *   - the web dashboard         24 actions (the 23 + github_app.installation_linked)
 *
 * `handleSetupReturn` (packages/web/src/lib/github-installations.ts) audits
 * `github_app.installation_linked`. The CHECK rejected it. `recordAuditEvent`
 * is deliberately non-throwing, so the constraint violation was logged to a
 * server console and discarded — every GitHub App link lost its audit row,
 * for the whole life of the feature, with nothing red anywhere.
 *
 * Nothing structural prevented that: three lists, no comparison. This spec is
 * the comparison. It asserts the canonical `@lorekit/schemas` list equals
 *
 *   (a) the action set in the NEWEST `audit_log` action-CHECK migration, and
 *   (b) both the union AND the `AUDIT_ACTION_META` keys in the web copy.
 *
 * The migration is DISCOVERED, not hardcoded: any future widening lands in a
 * higher-numbered file and is picked up automatically. Hardcoding `00042`
 * would mean the guard silently kept checking a superseded constraint.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const migrationsDir = path.join(repoRoot, 'supabase/migrations');
/** Collect capture group 1 from every match, skipping any that did not participate. */
function captures(matches: Iterable<RegExpMatchArray>): string[] {
  return [...matches].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

const webAuditActionsFile = path.join(repoRoot, 'packages/web/src/lib/audit-actions.ts');

/** `NNNNN_name.sql` → the leading number, or -1 when it does not match. */
function migrationNumber(filename: string): number {
  const m = /^(\d+)_/.exec(filename);
  return m ? Number(m[1]) : -1;
}

/**
 * Does this migration REDEFINE the `audit_log.action` CHECK?
 *
 * Both idioms count: the original table definition (00010, `action text not
 * null check (action in (...))`) and the forward-only widenings (00023/00027/
 * 00042, `alter table audit_log add constraint audit_log_action_check check
 * (action in (...))`). Matching on `action in (` inside a file that also
 * mentions `audit_log` is deliberately broad — a false positive here would be
 * a file that defines the vocabulary and should be checked anyway.
 */
function definesActionCheck(source: string): boolean {
  return /audit_log/.test(source) && /check\s*\(\s*action\s+in\s*\(/i.test(source);
}

/** Pull the quoted action literals out of the LAST `action in ( … )` list. */
function parseActionCheck(source: string): string[] {
  // Strip `--` line comments first: 00042's header quotes action names in
  // prose, and an un-stripped comment would leak them into the parse.
  const code = source
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

  const start = code.toLowerCase().lastIndexOf('action in (');
  if (start === -1) throw new Error('no `action in (` clause found');

  // Walk to the matching close paren of the `in (` list.
  let depth = 0;
  let end = -1;
  for (let i = code.indexOf('(', start); i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('unbalanced parentheses in the `action in ( … )` list');

  const body = code.slice(code.indexOf('(', start) + 1, end);
  return captures(body.matchAll(/'([^']+)'/g));
}

/** The highest-numbered migration that (re)defines the action CHECK. */
function newestActionCheckMigration(): { file: string; actions: string[] } {
  const candidates = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => definesActionCheck(readFileSync(path.join(migrationsDir, f), 'utf8')))
    .sort((a, b) => migrationNumber(a) - migrationNumber(b));

  const file = candidates.at(-1);
  if (!file) throw new Error(`no audit_log action-CHECK migration found in ${migrationsDir}`);
  return { file, actions: parseActionCheck(readFileSync(path.join(migrationsDir, file), 'utf8')) };
}

/** The `AUDIT_ACTIONS` tuple literal in the web copy. */
function parseWebUnion(source: string): string[] {
  const m = /export const AUDIT_ACTIONS = \[([\s\S]*?)\] as const;/.exec(source);
  if (!m) throw new Error('could not find `export const AUDIT_ACTIONS = [ … ] as const;`');
  return captures((m[1] ?? '').matchAll(/'([^']+)'/g));
}

/** The keys of the web copy's `AUDIT_ACTION_META` record. */
function parseWebMetaKeys(source: string): string[] {
  const m = /export const AUDIT_ACTION_META: Record<AuditAction, AuditActionMeta> = \{([\s\S]*?)\n\};/.exec(source);
  if (!m) throw new Error('could not find `export const AUDIT_ACTION_META … = { … };`');
  return captures((m[1] ?? '').matchAll(/^\s*'([^']+)':/gm));
}

const migration = newestActionCheckMigration();
const webSource = readFileSync(webAuditActionsFile, 'utf8');
const webUnion = parseWebUnion(webSource);
const webMetaKeys = parseWebMetaKeys(webSource);

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe('audit action vocabulary — one list, four places', () => {
  // ── anti-vacuity: the parsers actually found something ────────────────────
  it('the canonical list is non-empty and duplicate-free', () => {
    expect(AUDIT_ACTIONS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('discovered a plausible newest action-CHECK migration (not hardcoded)', () => {
    // The file is found by scanning, so record which one the assertions below
    // are actually about — a parser that silently matched nothing would fail
    // here rather than pass an empty comparison.
    expect(migration.file, 'no migration discovered').toMatch(/^\d+_.*\.sql$/);
    expect(migration.actions.length, `parsed no actions out of ${migration.file}`).toBeGreaterThanOrEqual(20);
    expect(new Set(migration.actions).size).toBe(migration.actions.length);
  });

  it('the newest CHECK migration supersedes every earlier one', () => {
    // Guards the discovery itself: if a widening were added with a LOWER
    // number than an existing one, the wrong file would be checked.
    const numbers = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => definesActionCheck(readFileSync(path.join(migrationsDir, f), 'utf8')))
      .map(migrationNumber);
    expect(numbers.length, 'expected at least the original + widenings').toBeGreaterThanOrEqual(2);
    expect(Math.max(...numbers)).toBe(migrationNumber(migration.file));
  });

  it('the web copy parsed to a non-empty union and meta record', () => {
    expect(webUnion.length).toBeGreaterThanOrEqual(20);
    expect(webMetaKeys.length).toBeGreaterThanOrEqual(20);
  });

  // ── the actual guards ─────────────────────────────────────────────────────
  it(`the SQL CHECK equals the canonical list (newest: ${migration.file})`, () => {
    expect(sorted(migration.actions)).toEqual(sorted(AUDIT_ACTIONS));
  });

  it('the web AuditAction union equals the canonical list', () => {
    // web deliberately has no @lorekit/schemas dependency (Next.js bundling +
    // allowImportingTsExtensions), so the copy stays — but it may not drift.
    expect(sorted(webUnion)).toEqual(sorted(AUDIT_ACTIONS));
  });

  it('the web AUDIT_ACTION_META covers exactly the canonical list', () => {
    // A missing key is a crash in the badge renderer; an extra key is a dead
    // action nothing can ever emit.
    expect(sorted(webMetaKeys)).toEqual(sorted(AUDIT_ACTIONS));
  });

  it('specifically admits github_app.installation_linked in all three places', () => {
    // The regression that motivated this file: the dashboard emitted it, the
    // CHECK rejected it, and the failure was swallowed.
    expect(AUDIT_ACTIONS).toContain('github_app.installation_linked');
    expect(migration.actions).toContain('github_app.installation_linked');
    expect(webUnion).toContain('github_app.installation_linked');
    expect(webMetaKeys).toContain('github_app.installation_linked');
  });

  it('every action a web server action or edge handler emits is in the CHECK', () => {
    // Source-scan backstop: catches an action string typed straight into a
    // call site that was never added to any list at all.
    const emitted = new Set<string>();
    const scanRoots = [
      path.join(repoRoot, 'packages/web/src/lib'),
      path.join(repoRoot, 'supabase/functions'),
      path.join(repoRoot, 'packages/mcp-core/src'),
    ];
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return e.isFile() && full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
      });
    for (const root of scanRoots) {
      for (const file of walk(root)) {
        const src = readFileSync(file, 'utf8');
        for (const a of captures(src.matchAll(/\baction:\s*'([a-z_]+\.[a-z_]+)'/g))) emitted.add(a);
      }
    }
    expect(emitted.size, 'found no `action: \'…\'` literals — the scan is broken').toBeGreaterThan(3);
    const unknown = [...emitted].filter((a) => !(AUDIT_ACTIONS as readonly string[]).includes(a));
    expect(unknown, 'these actions are emitted but are in no vocabulary').toEqual([]);
  });
});
