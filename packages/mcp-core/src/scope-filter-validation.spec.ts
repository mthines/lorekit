import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Every REST handler that turns a caller-supplied scope into a query predicate
 * must reject an ungrammatical one with a 400 instead of matching nothing and
 * calling the result empty.
 *
 * `supabase/functions/memories/CLAUDE.md` states the rule outright — "filtering
 * by a scope is the question itself, so a bad value is a `400`" — and
 * `handleReadActivity` implemented it. The other five scope-filtering handlers
 * did not: they passed the raw query value into `q.eq('scope', …)` / `p_scope`,
 * so `?scope=repo` (the bare token the /lore Explorer puts in the URL) produced
 * HTTP 200 with an empty page. Production saw 36 spans a day carrying
 * `lorekit.scope.type='invalid'`, none of them errors, because `UserInputError`
 * is deliberately not marked ERROR.
 *
 * REJECT-ONLY, NOT NORMALISE. `parseScopeFilter` throws on bad grammar and
 * returns the caller's string untouched. The REST write path does not normalise
 * (`CreateMemoryBodySchema` overrides `ScopeSchema` with `RawScopeSchema`;
 * `handlers/create.ts` passes `body.scope` verbatim; no `lower(scope)` exists in
 * any migration), so `memories.scope` legitimately holds mixed-case values and
 * lowercasing a filter would make those rows unmatchable — and undeletable by
 * natural key. The behavioural tests below pin that.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const handlerDir = path.join(repoRoot, 'supabase/functions/memories/handlers');
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

// ─────────────────────────────────────────────────────────────────────────────
// Behavioural: the shared helper every handler routes through.
//
// `supabase/functions/_shared/scope.ts` is plain TypeScript with no Deno-only
// imports, so vitest loads it directly — these assert real behaviour, not text.
// ─────────────────────────────────────────────────────────────────────────────

const edgeScope = (await import(
  path.join(repoRoot, 'supabase/functions/_shared/scope.ts')
)) as unknown as {
  parseScopeFilter: (raw: string | undefined) => string | undefined;
  validateScope: (raw: string) => string;
  UserInputError: new (m: string) => Error;
};

describe('parseScopeFilter', () => {
  const { parseScopeFilter, UserInputError } = edgeScope;

  it('rejects a bare scope TYPE used where a scope belongs', () => {
    // `repo` is the literal value the /lore Explorer puts in `?scope=` and the
    // one behind every `lorekit.scope.type='invalid'` span.
    expect(() => parseScopeFilter('repo')).toThrow(UserInputError);
    expect(() => parseScopeFilter('branch')).toThrow(UserInputError);
    expect(() => parseScopeFilter('nope')).toThrow(UserInputError);
  });

  it('rejects a single-colon separator', () => {
    expect(() => parseScopeFilter('repo:mthines/lorekit')).toThrow(
      /use "::" as the separator/,
    );
  });

  it('treats an absent filter as absent, not as an error', () => {
    expect(parseScopeFilter(undefined)).toBeUndefined();
  });

  it('accepts every canonical form and returns it UNCHANGED', () => {
    for (const scope of [
      'global',
      'project::lorekit-web-daily-report',
      'repo::mthines/lorekit',
      'branch::mthines/lorekit::fix/scope-filter-validation',
    ]) {
      expect(parseScopeFilter(scope)).toBe(scope);
    }
  });

  it('does NOT lowercase — a mixed-case scope survives the filter intact', () => {
    // The regression this guards against. `validateScope` lowercases; if that
    // result reached the predicate, a row written as `repo::Owner/Name` (which
    // the REST write path stores verbatim) would become unmatchable by list and
    // undeletable by natural key.
    expect(parseScopeFilter('repo::Owner/Name')).toBe('repo::Owner/Name');
    expect(parseScopeFilter('Project::MyThing')).toBe('Project::MyThing');
    // …while the underlying grammar check is genuinely the normalising one:
    expect(edgeScope.validateScope('repo::Owner/Name')).toBe('repo::owner/name');
  });

  it('stays reject-only for as long as the write path stays un-normalising', () => {
    // A tripwire, not a style rule. If someone normalises writes, this comes
    // down in the SAME change — otherwise existing rows are stranded.
    const create = readFileSync(path.join(handlerDir, 'create.ts'), 'utf8');
    expect(create).toMatch(/p_scope:\s*body\.scope\b/);
    expect(create).not.toMatch(/validateScope\(|parseScopeFilter\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Structural: every scope-filtering handler routes through that helper.
// ─────────────────────────────────────────────────────────────────────────────

// Every handler that turns a caller-supplied scope into a QUERY PREDICATE.
//
// `tags` and `scopes` are absent because they genuinely expose no scope filter
// (verified: their query schemas have no `scope` field, and neither handler
// references one).
//
// The ARRAY-valued paths are deliberately out of scope for this guard and are
// NOT fixed here: `handlers/search.ts` (`?scopes=` → `q.in('scope', …)`) and
// `handlers/relevant.ts` (same shape). They need a per-entry decision this
// change does not make — whether one bad entry rejects the whole request or is
// dropped — and the MCP twin (`mcp/tools.ts`, which validates each entry) is the
// precedent to reconcile against. Tracked separately; naming them here so their
// absence is a recorded decision rather than an oversight.
//
// That deferral is a SEMANTICS call about the per-entry outcome, and explicitly
// not a judgement that the charset check is optional there. Per
// `_shared/scope.ts:34`, the charset guard exists because a scope is
// interpolated into a PostgREST filter value where `"` `,` `(` `)` are
// structural — and `.in('scope', …)` is exactly that shape. So whichever
// per-entry outcome is chosen, every entry still has to pass the grammar; the
// open question is what to do with the request, not whether to check.
const SCOPE_FILTERING_HANDLERS: ReadonlyArray<readonly [string, string]> = [
  ['list.ts', 'handleList'],
  ['activity.ts', 'handleActivity'],
  ['remove.ts', 'handleRemove'],
  ['facets.ts', 'handleFacets'],
  ['restore.ts', 'handleRestore'],
  // The one that was already correct — kept so a regression there trips the
  // same guard. It predates `parseScopeFilter` and calls `validateScope`
  // directly, which is why the assertion below accepts either.
  ['read-activity.ts', 'handleReadActivity'],
];

describe('REST scope filters are validated before they reach a query', () => {
  it.each(SCOPE_FILTERING_HANDLERS)('%s / %s validates the scope filter', (file, fn) => {
    const body = handlerBody(read(file), fn);
    expect(body).toMatch(/(parseScopeFilter|validateScope)\(/);
  });

  it.each(SCOPE_FILTERING_HANDLERS)(
    '%s / %s turns THAT rejection specifically into a 400',
    (file, fn) => {
      const body = handlerBody(read(file), fn);
      // Not "a badRequest exists somewhere in the handler" — several of these
      // have unrelated ones, which made the looser form of this assertion pass
      // on unfixed code. Require the catch that wraps the scope call to be the
      // thing returning badRequest.
      const call = body.search(/(parseScopeFilter|validateScope)\(/);
      expect(call).toBeGreaterThan(-1);
      const window = body.slice(call, call + 320);
      expect(window).toMatch(/catch\s*\(\s*e\s*\)\s*\{[\s\S]{0,120}?return badRequest\(/);
    },
  );

  it.each(SCOPE_FILTERING_HANDLERS)(
    '%s / %s imports the validator from the canonical module',
    (file) => {
      const src = read(file);
      expect(src).toMatch(
        /import \{[^}]*(parseScopeFilter|validateScope)[^}]*\} from '\.\.\/\.\.\/_shared\/scope\.ts'/,
      );
    },
  );

  it.each(SCOPE_FILTERING_HANDLERS)(
    '%s / %s never reaches a predicate with the unvalidated value',
    (file, fn) => {
      const body = handlerBody(read(file), fn);
      // Name the validated binding, then require every scope predicate in the
      // handler to use it. This is the assertion that a rename or an alias
      // could previously slip past.
      const bound = body.match(
        /(?:let|const)\s+(\w+)(?:\s*:\s*[^=;]+)?\s*(?:=\s*)?[\s\S]{0,200}?=\s*(?:parseScopeFilter|validateScope)\(/,
      );
      expect(bound, `no binding captured from the validator in ${fn}`).not.toBeNull();
      const name = bound![1];

      // Every `.eq('scope', X)` and `p_scope: X` must use that binding.
      for (const m of body.matchAll(/\.eq\(\s*'scope'\s*,\s*([^)]+?)\s*\)/g)) {
        expect(m[1], `${fn}: .eq('scope', ${m[1]}) does not use ${name}`).toContain(name);
      }
      for (const m of body.matchAll(/p_scope:\s*([^,\n]+)/g)) {
        expect(m[1], `${fn}: p_scope: ${m[1]} does not use ${name}`).toContain(name);
      }
    },
  );

  it('covers every handler that filters by a single scope', () => {
    // Completeness check: scan the whole handler directory for a scope
    // predicate and assert the list above accounts for it. An earlier revision
    // of this spec asserted facets.ts had no scope filter — it does — so the
    // list is now derived from the source rather than from memory.
    const listed = new Set(SCOPE_FILTERING_HANDLERS.map(([f]) => f));
    // `create.ts` matches the predicate pattern (`p_scope: body.scope`) but is
    // the WRITE path, not a filter — it is what STORES the scope, and it is
    // deliberately un-normalising. Validating it here would be a different
    // change with a data-migration question attached. It is pinned instead by
    // the "stays reject-only" tripwire above, which fails if it ever starts
    // normalising without this guard coming down in the same commit.
    listed.add('create.ts');
    // `.in('scope', …)` is the array-valued family, excluded by decision above.
    const singleScopePredicate = /\.eq\(\s*'scope'\s*,|p_scope:/;
    const missed: string[] = [];
    for (const file of readdirSync(handlerDir).filter((f) => f.endsWith('.ts'))) {
      if (listed.has(file)) continue;
      if (singleScopePredicate.test(read(file))) missed.push(file);
    }
    expect(missed, `handlers filter by scope but are not guarded: ${missed.join(', ')}`).toEqual(
      [],
    );
  });
});
