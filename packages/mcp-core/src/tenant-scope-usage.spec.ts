import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard: every memories READ in the edge api_key path must route
 * through applyTenantScope — the single enforced tenant-visibility
 * predicate (Requirement R2). A read handler that inlines its own
 * `.eq('user_id', userId)` instead bypasses the shared helper and can
 * silently diverge from the RLS-side predicate (plan.md pre-mortem risk #2:
 * predicate drift -> cross-tenant read leak).
 *
 * This scans the edge `tools.ts` source (not mcp-core) — the edge api_key
 * path is where the tenant predicate is hand-applied per handler, because
 * the service-role client bypasses RLS. mcp-core's tools/*.ts handlers take
 * a pre-scoped db and rely on RLS for widening (see plan.md Technical
 * Approach) — no equivalent app-layer predicate exists there to drift.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsPath = path.resolve(here, '../../../supabase/functions/mcp/tools.ts');
const source = readFileSync(toolsPath, 'utf8');

// The four read handlers widened in Phase 1 (plan.md Technical Approach #2).
// Write/delete/archive/restore/purge stay personal-only (Requirement R7) and
// are deliberately excluded from this guard.
const READ_HANDLERS = ['toolRead', 'toolList', 'toolSearch', 'toolListArchived'];

function extractFunctionBody(src: string, fnName: string): string {
  const signature = `export async function ${fnName}(`;
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`handler ${fnName} not found in tools.ts`);
  const paramsEnd = src.indexOf(')', start);
  const bodyStart = src.indexOf('{', paramsEnd);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`could not find end of function body for ${fnName}`);
}

describe('tenant-scope usage guard (edge read handlers)', () => {
  it('imports applyTenantScope from the shared tenant-scope module', () => {
    expect(source).toMatch(/import\s*\{\s*applyTenantScope\s*\}\s*from\s*['"]\.\/tenant-scope\.(ts|js)['"]/);
  });

  it.each(READ_HANDLERS)('%s routes its memories read through applyTenantScope', (fnName) => {
    const body = extractFunctionBody(source, fnName);
    expect(body).toContain('applyTenantScope(');
    expect(body).not.toMatch(/\.eq\(\s*['"]user_id['"]/);
  });
});
