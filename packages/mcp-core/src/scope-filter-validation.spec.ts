import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard: every REST handler that FILTERS by a caller-supplied `?scope=`
 * must run it through the canonical `validateScope` first.
 *
 * The REST query schemas bind `scope` to `RawScopeSchema` — shape-only — on
 * purpose, and say so:
 *
 *   DeleteMemoryQuerySchema: "`RawScopeSchema` (shape-only) rather than
 *   `ScopeSchema` … normalisation happens downstream."
 *
 *   ReadActivityQuerySchema: "It is `RawScopeSchema` (shape-only) … so the
 *   canonical normalisation happens once, in the handler, which can turn a
 *   rejection into a 400 — the `?correlation_id=` precedent."
 *
 * `handleReadActivity` implements that second half. The other scope-filtering
 * handlers did not, so an ungrammatical scope became a filter matching nothing
 * and the endpoint answered HTTP 200 with an empty page — a different question
 * than the one asked, under the label the caller used. Production saw 36 spans
 * a day with `lorekit.scope.type = 'invalid'` and none of them were errors,
 * because `UserInputError` is deliberately not marked ERROR.
 *
 * Scans the Deno edge sources, which vitest cannot import — the same approach
 * as `tenant-scope-usage.spec.ts` and `mcp-authz-status.spec.ts`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const handlerDir = path.resolve(here, '../../../supabase/functions/memories/handlers');
const read = (f: string) => readFileSync(path.join(handlerDir, f), 'utf8');

/** Slice a handler's body by brace-depth so nested braces do not end it early. */
function handlerBody(src: string, fnName: string): string {
  const at = src.indexOf(`export async function ${fnName}(`);
  if (at === -1) throw new Error(`handler ${fnName} not found`);
  const bodyStart = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(bodyStart, i + 1);
  }
  throw new Error(`could not find end of ${fnName}`);
}

// Every handler that turns a caller-supplied scope into a QUERY PREDICATE.
// `facets`, `tags` and `scopes` are deliberately absent: they expose no scope
// filter at all (their query schemas have no `scope` field), so there is
// nothing to validate. A future handler that adds one belongs in this list.
const SCOPE_FILTERING_HANDLERS: ReadonlyArray<readonly [string, string]> = [
  ['list.ts', 'handleList'],
  ['activity.ts', 'handleActivity'],
  ['remove.ts', 'handleRemove'],
  // The one that was already correct — kept in the list so a regression there
  // is caught by the same guard that caught the other three.
  ['read-activity.ts', 'handleReadActivity'],
];

describe('REST scope filters are validated before they reach a query', () => {
  it.each(SCOPE_FILTERING_HANDLERS)('%s / %s validates the scope filter', (file, fn) => {
    const body = handlerBody(read(file), fn);
    expect(body).toMatch(/validateScope\(/);
  });

  it.each(SCOPE_FILTERING_HANDLERS)('%s / %s turns a rejection into a 400', (file, fn) => {
    const body = handlerBody(read(file), fn);
    // The rejection must become a client error, not a 500 and not a silent
    // empty result. `UserInputError` is caught and answered with badRequest().
    expect(body).toMatch(/badRequest\(/);
  });

  it.each(SCOPE_FILTERING_HANDLERS)(
    '%s / %s imports validateScope from the canonical module',
    (file) => {
      const src = read(file);
      expect(src).toMatch(/import \{[^}]*validateScope[^}]*\} from '\.\.\/\.\.\/_shared\/scope\.ts'/);
    },
  );

  it('never filters on the raw, unvalidated query value', () => {
    // The specific regression this guards: `q.eq('scope', params.scope)` and
    // `p_scope: params.scope` bypass the validator entirely.
    for (const [file] of SCOPE_FILTERING_HANDLERS) {
      const src = read(file);
      expect(src).not.toMatch(/\.eq\('scope',\s*params\.scope\)/);
      expect(src).not.toMatch(/p_scope:\s*params\.scope\b/);
    }
  });
});

/**
 * The behavioural half: the exact values production sends.
 *
 * The edge validator is a hand-maintained mirror of this package's copy and is
 * deliberately excluded from `edge-parity.spec.ts` (the two bodies differ), so
 * its behaviour on these inputs is asserted directly rather than inferred.
 */
describe('edge validateScope rejects what the Explorer actually sends', () => {
  const edgeScope = readFileSync(
    path.resolve(here, '../../../supabase/functions/_shared/scope.ts'),
    'utf8',
  );

  it('rejects a bare scope TYPE used where a scope belongs', async () => {
    // `repo` is the literal value the /lore Explorer puts in `?scope=`.
    const { validateScope, UserInputError } = await importEdgeScope();
    expect(() => validateScope('repo')).toThrow(UserInputError);
    expect(() => validateScope('branch')).toThrow(UserInputError);
  });

  it('rejects a single-colon separator', async () => {
    const { validateScope } = await importEdgeScope();
    expect(() => validateScope('repo:mthines/lorekit')).toThrow(/use "::" as the separator/);
  });

  it('normalises case so a filter matches the rows writes actually stored', async () => {
    // Writes store `validateScope`-normalised scopes, so an unnormalised filter
    // silently misses real rows. This is the half of the fix that is not about
    // rejection at all.
    const { validateScope } = await importEdgeScope();
    expect(validateScope('Repo::MThines/LoreKit')).toBe('repo::mthines/lorekit');
    expect(validateScope('  global  ')).toBe('global');
  });

  it('accepts every canonical form unchanged', async () => {
    const { validateScope } = await importEdgeScope();
    for (const scope of [
      'global',
      'project::lorekit-web-daily-report',
      'repo::mthines/lorekit',
      'branch::mthines/lorekit::fix/scope-filter-validation',
    ]) {
      expect(validateScope(scope)).toBe(scope);
    }
  });

  it('is the module the handlers import', () => {
    expect(edgeScope).toMatch(/export function validateScope\(/);
    expect(edgeScope).toMatch(/export class UserInputError extends Error/);
  });
});

/**
 * The edge tree is plain TypeScript with `.ts` specifiers and no Deno-only
 * imports in `_shared/scope.ts`, so vitest can load it directly through Vite's
 * transform — no mirror copy and no duplicated grammar.
 */
async function importEdgeScope(): Promise<{
  validateScope: (raw: string) => string;
  UserInputError: new (m: string) => Error;
}> {
  return (await import(
    path.resolve(here, '../../../supabase/functions/_shared/scope.ts')
  )) as unknown as {
    validateScope: (raw: string) => string;
    UserInputError: new (m: string) => Error;
  };
}
