import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AUDIT_ACTIONS } from '@lorekit/schemas/audit';

/**
 * Drift guard: the `audit_log.action` vocabulary exists in TWO runtimes that
 * cannot import each other — TypeScript (`packages/schemas/src/audit.ts`, the
 * single source of truth for every writer and the dashboard) and SQL (the
 * CHECK constraint on `audit_log.action`, the only copy Postgres actually
 * enforces). This suite is the seam between them.
 *
 * It exists because the seam has ALREADY failed once, silently and in
 * production. The dashboard's `handleSetupReturn`
 * (`packages/web/src/lib/github-installations.ts`) audits
 * `github_app.installation_linked`; the CHECK last rewritten by
 * `00027_audit_log_scope_actions.sql` did not admit it; Postgres rejected the
 * INSERT; `recordAuditEvent` — correctly non-throwing, so an audit failure can
 * never break the operation it audits — swallowed the error. The result was an
 * action the UI could render, the writer would emit, and the database would
 * never store. `00040_audit_log_github_app_action.sql` fixes the instance; this
 * suite fixes the class.
 *
 * The three asserted invariants:
 *
 *  1. The LATEST CHECK's action list == `AUDIT_ACTIONS`, as a set. Adding an
 *     action to the tuple without a widening migration (or vice versa) fails.
 *  2. `AUDIT_ACTION_META` in `packages/web/src/lib/audit-actions.ts` has exactly
 *     one entry per action — no missing key (which would crash the badge
 *     renderer on a real row) and no extra (a dead entry for an action nothing
 *     can emit). This is scanned from source rather than imported because
 *     `audit-actions.ts` pulls in `lucide-react`, which has no business being
 *     loaded by a Node-environment mcp-core test.
 *  3. Anti-vacuity: the parsed list must be longer than 20 entries. Every
 *     assertion here is regex-driven over source text, and the failure mode
 *     that matters most is a regex that quietly matches nothing and compares
 *     two empty sets. A hard floor makes that unrepresentable.
 *
 * The latest migration is DISCOVERED, never hardcoded: the scan finds every
 * migration that defines the constraint and takes the highest-numbered one, so
 * the next widening migration is picked up with no edit to this file.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src
const repoRoot = path.resolve(here, '../../..');
const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
const webAuditActionsPath = path.join(repoRoot, 'packages', 'web', 'src', 'lib', 'audit-actions.ts');

/**
 * A migration that (re)defines the audit_log action CHECK. Matches both the
 * original `create table` form (00010) and the forward-only drop-and-re-add
 * form (00023 / 00027 / 00040) by anchoring on the constraint name plus the
 * `action in (...)` list it carries.
 */
const CHECK_PATTERN = /constraint\s+audit_log_action_check\s+check\s*\(\s*action\s+in\s*\(([^)]*)\)/i;

interface ParsedCheck {
  file: string;
  actions: string[];
}

/** Every `'…'` string literal in a SQL IN-list. */
function parseActionList(inList: string): string[] {
  return [...inList.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

function findLatestCheckMigration(): ParsedCheck {
  const candidates: ParsedCheck[] = [];
  // readdirSync is unordered on some filesystems; sort by the numeric prefix so
  // "latest" means the highest migration number, not the last name alphabetically
  // (which would break the day a migration is numbered 00100).
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => (Number.parseInt(a, 10) || 0) - (Number.parseInt(b, 10) || 0));

  for (const file of files) {
    const source = readFileSync(path.join(migrationsDir, file), 'utf8');
    const match = CHECK_PATTERN.exec(source);
    if (match) candidates.push({ file, actions: parseActionList(match[1]!) });
  }

  if (candidates.length === 0) {
    throw new Error(
      `no migration in ${migrationsDir} defines audit_log_action_check — the CHECK_PATTERN regex is stale`,
    );
  }
  return candidates[candidates.length - 1]!;
}

const latest = findLatestCheckMigration();

describe('audit_log action vocabulary — SQL CHECK vs @lorekit/schemas', () => {
  it('found a migration defining the CHECK, and it parsed a non-trivial action list', () => {
    // Anti-vacuity. A regex that matched an empty list would make every
    // set comparison below trivially true.
    expect(latest.file).toMatch(/\.sql$/);
    expect(
      latest.actions.length,
      `parsed only ${latest.actions.length} action(s) out of ${latest.file} — the regex is almost certainly matching the wrong thing`,
    ).toBeGreaterThan(20);
  });

  it('parses a list with no duplicates', () => {
    expect(new Set(latest.actions).size).toBe(latest.actions.length);
  });

  it('the latest CHECK admits exactly the actions in AUDIT_ACTIONS', () => {
    const inSqlNotTs = latest.actions.filter((a) => !(AUDIT_ACTIONS as readonly string[]).includes(a));
    const inTsNotSql = AUDIT_ACTIONS.filter((a) => !latest.actions.includes(a));

    expect(
      { inSqlNotTs, inTsNotSql },
      `the audit_log.action CHECK in ${latest.file} has drifted from AUDIT_ACTIONS in packages/schemas/src/audit.ts.\n` +
        `  in SQL but not in TS: ${inSqlNotTs.join(', ') || '(none)'}\n` +
        `  in TS but not in SQL: ${inTsNotSql.join(', ') || '(none)'}\n` +
        'An action in TS but not in SQL is SILENT AUDIT LOSS: the writer emits it, Postgres rejects the insert, and the non-throwing writer swallows the error. Add a forward-only drop-and-re-add CHECK migration.',
    ).toEqual({ inSqlNotTs: [], inTsNotSql: [] });
  });
});

describe('AUDIT_ACTION_META (packages/web/src/lib/audit-actions.ts)', () => {
  const source = readFileSync(webAuditActionsPath, 'utf8');
  const block = /AUDIT_ACTION_META\s*:\s*Record<AuditAction,\s*AuditActionMeta>\s*=\s*\{([\s\S]*?)\n\};/.exec(source);
  const metaKeys = block ? [...block[1]!.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]!) : [];

  it('located the AUDIT_ACTION_META record and parsed a non-trivial key set', () => {
    // Anti-vacuity, same reasoning as above.
    expect(block, `could not locate AUDIT_ACTION_META in ${webAuditActionsPath}`).not.toBeNull();
    expect(metaKeys.length).toBeGreaterThan(20);
  });

  it('has exactly one entry per AUDIT_ACTION — no missing keys, no extras', () => {
    const missing = AUDIT_ACTIONS.filter((a) => !metaKeys.includes(a));
    const extra = metaKeys.filter((k) => !(AUDIT_ACTIONS as readonly string[]).includes(k));

    expect(
      { missing, extra },
      'AUDIT_ACTION_META has drifted from AUDIT_ACTIONS. A missing key crashes the audit badge on a real row; an extra key is dead UI for an action nothing can emit.',
    ).toEqual({ missing: [], extra: [] });
  });

  it('has no duplicate keys', () => {
    expect(new Set(metaKeys).size).toBe(metaKeys.length);
  });
});
