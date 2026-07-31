import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AUDIT_ACTIONS } from './audit.js';

/**
 * Drift guard: every mutating `orgs` REST route writes an audit row.
 *
 * The org routes were `requires: 'jwt'` until `00041_org_actor_override.sql`,
 * and were deliberately NOT audited for a reason that has now expired: the
 * actor resolved to `null` for every caller, so each insert would have been
 * swallowed by `audit_log`'s `user_id = auth.uid()` INSERT policy — guaranteed
 * dead code rather than coverage. With an `lk_*` API token now resolving to a
 * real actor over a service-role connection (which bypasses RLS), those rows
 * land. Auditing them is no longer optional: as the CLI and the Node MCP server
 * migrate onto REST, an unaudited route silently switches the audit trail off
 * for the operation it serves — the mutation still happens, it just stops being
 * recorded, and nothing in the app layer can observe the loss.
 *
 * That failure mode is invisible to a behavioural test (the route returns 200
 * either way) and invisible to review of any single file, so this is a SOURCE
 * SCAN, modelled on `org-actor-usage.spec.ts` and `tenant-scope-usage.spec.ts`.
 *
 * It resolves handlers the way the runtime does — through `orgs/index.ts`'s own
 * route table and import statements — rather than by globbing `handlers/**`, so
 * a handler that is registered but lives somewhere unexpected is still covered,
 * and a file that is no longer routed is not held to a rule that does not apply
 * to it.
 *
 * This checks CALL PRESENCE and VOCABULARY, not correctness: that a mutating
 * handler mentions the writer, that a GET handler does not, and that every
 * action literal is one the bounded `AUDIT_ACTIONS` list (and therefore the
 * `audit_log` CHECK) admits. Whether the row is written on the success path
 * with the right target is a review concern. What it guarantees is that neither
 * can go missing SILENTLY.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src
const repoRoot = path.resolve(here, '../../..');
const orgsDir = path.join(repoRoot, 'supabase', 'functions', 'orgs');
const indexFile = path.join(orgsDir, 'index.ts');

/** The single REST audit writer, `supabase/functions/_shared/audit.ts`. */
const AUDIT_WRITER = 'recordRestAudit';

/**
 * `\b`-anchored on BOTH sides of the name so a look-alike cannot satisfy it:
 * `NOPE_recordRestAudit(` and `recordRestAuditLater(` both fail, while
 * `await recordRestAudit(` and `recordRestAudit (` pass.
 */
const AUDIT_CALL = new RegExp(String.raw`\b${AUDIT_WRITER}\b\s*\(`);

const rel = (f: string) => path.relative(repoRoot, f);

const indexSource = readFileSync(indexFile, 'utf8');

/**
 * `import { handleRenameOrg } from './handlers/orgs/rename.ts';`
 * -> handler name -> absolute file path. Multiple named imports per statement
 * are handled, so a future consolidation of the imports does not blind this.
 */
function handlerImports(): Map<string, string> {
  const map = new Map<string, string>();
  const IMPORT = /import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/g;
  for (const m of indexSource.matchAll(IMPORT)) {
    const target = path.resolve(orgsDir, m[2]!);
    for (const raw of m[1]!.split(',')) {
      const name = raw.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (name) map.set(name, target);
    }
  }
  return map;
}

interface Route {
  method: string;
  path: string;
  handler: string;
  file: string;
}

/** Parses the `createRouter([...])` table, keeping each route's handler name. */
function routes(): Route[] {
  const imports = handlerImports();
  const ROUTE = /method:\s*'(\w+)'\s*,\s*path:\s*'([^']+)'\s*,\s*handler:\s*(\w+)/g;
  return [...indexSource.matchAll(ROUTE)].map((m) => {
    const handler = m[3]!;
    const file = imports.get(handler);
    if (!file) {
      throw new Error(
        `orgs/index.ts routes ${m[1]} ${m[2]} to ${handler}, but no relative import declares it — ` +
          'the import regex in rest-org-audit-usage.spec.ts is stale.',
      );
    }
    return { method: m[1]!.toUpperCase(), path: m[2]!, handler, file };
  });
}

const allRoutes = routes();
const mutating = allRoutes.filter((r) => r.method !== 'GET');
const reading = allRoutes.filter((r) => r.method === 'GET');

/**
 * Every `action:` literal appearing anywhere under the org handlers. Captured
 * per LINE rather than per call, so the ternary form
 * `action: isSelf ? 'member.leave' : 'member.remove'` contributes BOTH values —
 * a per-call "first string wins" parse would let the second one drift
 * unchecked.
 */
function actionLiterals(files: readonly string[]): { file: string; action: string }[] {
  const found: { file: string; action: string }[] = [];
  for (const file of new Set(files)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const decl = /\baction\s*:\s*(.*)$/.exec(line);
      if (!decl) continue;
      for (const q of decl[1]!.matchAll(/'([^']+)'/g)) found.push({ file, action: q[1]! });
    }
  }
  return found;
}

const actions = actionLiterals(allRoutes.map((r) => r.file));

describe('orgs route scan (anti-vacuity)', () => {
  // Without these floors a stale regex yields empty sets and every per-route
  // assertion below passes vacuously — the way a drift guard rots into
  // decoration.
  it('parsed the orgs route table', () => {
    expect(
      allRoutes.length,
      `only ${allRoutes.length} routes parsed out of ${rel(indexFile)} — ROUTE regex is probably stale`,
    ).toBeGreaterThanOrEqual(11);
  });

  it('found at least 7 mutating routes', () => {
    expect(
      mutating.length,
      `only ${mutating.length} non-GET routes found; the orgs function registers create/rename/delete, ` +
        'member role-change/remove and invite create/revoke at minimum',
    ).toBeGreaterThanOrEqual(7);
  });

  it('found the read-only routes', () => {
    expect(reading.length, 'no GET routes parsed — the GET assertions would be vacuous').toBeGreaterThanOrEqual(4);
  });

  it('resolved every route handler to a file that exists', () => {
    const missing = allRoutes.filter((r) => !existsSync(r.file)).map((r) => `${r.handler} -> ${rel(r.file)}`);
    expect(missing, 'route handlers resolved to files that do not exist').toEqual([]);
  });

  it('found the audit action literals', () => {
    expect(
      actions.length,
      'no `action:` literals found under the org handlers — actionLiterals() is probably stale, which would ' +
        'make the AUDIT_ACTIONS membership check below vacuous',
    ).toBeGreaterThanOrEqual(8);
  });
});

describe('every mutating orgs route audits', () => {
  it.each(mutating.map((r) => [`${r.method} ${r.path} -> ${r.handler}`, r] as const))(
    '%s calls the shared audit writer',
    (_label, route) => {
      const source = readFileSync(route.file, 'utf8');

      expect(
        AUDIT_CALL.test(source),
        `${rel(route.file)} handles ${route.method} ${route.path} but never calls ${AUDIT_WRITER}(). ` +
          'A mutating org route that does not audit silently drops its row from the trail the dashboard and ' +
          'the MCP surface both write to — invisible at runtime, since the route still returns 2xx. Call ' +
          `${AUDIT_WRITER}(db, span, auth, { action: … }) after the RPC succeeds.`,
      ).toBe(true);

      // It must be THE shared writer from _shared/audit.ts. A locally defined
      // helper — or a second edge audit module — is exactly what this guard
      // exists to prevent: the two surfaces must produce comparable rows.
      expect(
        source,
        `${rel(route.file)} references ${AUDIT_WRITER} without importing it from _shared/audit.ts`,
      ).toMatch(
        new RegExp(String.raw`import\s*\{[^}]*\b${AUDIT_WRITER}\b[^}]*\}\s*from\s*['"][^'"]*_shared/audit\.ts['"]`),
      );
    },
  );
});

describe('read-only orgs routes do not audit', () => {
  it.each(reading.map((r) => [`${r.method} ${r.path} -> ${r.handler}`, r] as const))(
    '%s writes no audit row',
    (_label, route) => {
      // A GET that audits is noise at best (one row per page load) and a write
      // on a read path at worst. `audit_log` records mutations only.
      const source = readFileSync(route.file, 'utf8');
      expect(
        AUDIT_CALL.test(source),
        `${rel(route.file)} handles the read-only ${route.method} ${route.path} but calls ${AUDIT_WRITER}(). ` +
          'audit_log records mutations only.',
      ).toBe(false);
    },
  );
});

describe('every org audit action is in the bounded vocabulary', () => {
  const allowed = new Set<string>(AUDIT_ACTIONS);

  it.each([...new Set(actions.map((a) => `${rel(a.file)}::${a.action}`))].map((k) => [k] as const))(
    '%s is a member of AUDIT_ACTIONS',
    (label) => {
      const action = label.split('::')[1]!;
      expect(
        allowed.has(action),
        `"${action}" is not in AUDIT_ACTIONS (packages/mcp-core/src/audit.ts and its edge mirror). It would fail ` +
          "the audit_log `action` CHECK, and recordAudit swallows the rejection — so the row is lost with no " +
          'error anywhere. Widen the CHECK in a new forward-only migration first, then both AUDIT_ACTIONS ' +
          'copies, then packages/web/src/lib/audit-actions.ts.',
      ).toBe(true);
    },
  );
});
