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
const repoRoot = path.resolve(here, '../../../..');
const handlerDir = path.join(repoRoot, 'supabase/functions/memories/handlers');
const read = (f: string) => readFileSync(path.join(handlerDir, f), 'utf8');

/**
 * Slice a handler's body by brace-depth so nested braces do not end it early.
 *
 * The function named is not always the exported route entry point: `list.ts`,
 * `activity.ts` and `facets.ts` each decode two transports (`GET` + `POST`) into
 * one shape and hand it to a single module-private reader, which is where the
 * scope filter is validated — once, so the two transports cannot diverge on
 * which scopes they accept. So `export` is optional here.
 */
function handlerBody(src: string, fnName: string): string {
  const at = src.search(new RegExp(`(?:export )?async function ${fnName}\\(`));
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
// `supabase/functions/_shared/scope/scope.ts` is plain TypeScript with no Deno-only
// imports, so vitest loads it directly — these assert real behaviour, not text.
// ─────────────────────────────────────────────────────────────────────────────

const edgeScope = (await import(
  path.join(repoRoot, 'supabase/functions/_shared/scope/scope.ts')
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

  it('rejects surrounding whitespace instead of filtering on a value that cannot match', () => {
    // `validateScope` trims before it checks, so ` global` is grammatical to
    // it — and the untrimmed string then reaches `.eq('scope', ' global')` and
    // matches nothing. That is the 200-with-an-empty-page this change removes,
    // so the padded form is bad input, not an empty result.
    expect(() => parseScopeFilter(' global')).toThrow(UserInputError);
    expect(() => parseScopeFilter('global ')).toThrow(/remove the surrounding whitespace/);
    expect(() => parseScopeFilter('\trepo::mthines/lorekit\n')).toThrow(UserInputError);
    // Rejected, never silently trimmed — the caller's question is not rewritten.
    expect(parseScopeFilter('global')).toBe('global');
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
// `_shared/scope/scope.ts:34`, the charset guard exists because a scope is
// interpolated into a PostgREST filter value where `"` `,` `(` `)` are
// structural — and `.in('scope', …)` is exactly that shape. So whichever
// per-entry outcome is chosen, every entry still has to pass the grammar; the
// open question is what to do with the request, not whether to check.
// The third element PINS WHICH validator the handler must use, so the guard
// covers case handling and not only grammar. The two are not interchangeable:
// `parseScopeFilter` rejects without normalising and `validateScope` lowercases,
// and which one is correct follows the column the route filters.
//
//   - `memories.scope` is written VERBATIM over REST (`CreateMemoryBodySchema`
//     binds `RawScopeSchema`; `handlers/create.ts` passes `body.scope` through;
//     no migration lowers it), so its filters must be reject-only or a
//     mixed-case row becomes unmatchable and undeletable by natural key.
//   - `usage_events.scope` is written through the NORMALISING
//     `safeValidateScope` at the recording site (`_shared/api/router.ts`), so
//     `read-activity` must lowercase its filter or a mixed-case request misses
//     rows that are all stored lowercased.
//
// The divergence is therefore intended and load-bearing, and swapping either
// one strands rows — which is why this is pinned per handler rather than left
// as "calls one of the two".
const SCOPE_FILTERING_HANDLERS: ReadonlyArray<readonly [string, string, string]> = [
  // The three dual-transport routes name their shared reader, not the exported
  // `GET`/`POST` entry point: both transports decode into one shape and only the
  // reader touches the scope, so validating there is what stops `GET /memories`
  // and `POST /memories/list` disagreeing about which scopes are legal. The
  // entry points are pinned to route through it by DUAL_TRANSPORT_ROUTES below.
  ['list.ts', 'respondWithPage', 'parseScopeFilter'],
  ['activity.ts', 'runActivity', 'parseScopeFilter'],
  ['facets.ts', 'runFacets', 'parseScopeFilter'],
  ['remove.ts', 'handleRemove', 'parseScopeFilter'],
  ['restore.ts', 'handleRestore', 'parseScopeFilter'],
  // The one that was already correct, and the one that must NOT move to
  // `parseScopeFilter`: it reads the normalised `usage_events.scope`.
  ['read-activity.ts', 'handleReadActivity', 'validateScope'],
];

describe('REST scope filters are validated before they reach a query', () => {
  it.each(SCOPE_FILTERING_HANDLERS)('%s / %s validates the scope filter', (file, fn) => {
    const body = handlerBody(read(file), fn);
    expect(body).toMatch(/(parseScopeFilter|validateScope)\(/);
  });

  it.each(SCOPE_FILTERING_HANDLERS)(
    '%s / %s uses %s specifically, so case handling follows its column',
    (file, fn, validator) => {
      const other = validator === 'parseScopeFilter' ? 'validateScope' : 'parseScopeFilter';
      const body = handlerBody(read(file), fn);
      expect(body, `${fn} must validate its scope filter with ${validator}`).toMatch(
        new RegExp(`\\b${validator}\\(`),
      );
      // `parseScopeFilter` delegates to `validateScope` internally, but the
      // handler must not call the normalising one itself (or the raw one where
      // normalisation is required) — that is the swap that strands rows.
      expect(body, `${fn} must not reach for ${other}`).not.toMatch(new RegExp(`\\b${other}\\(`));
    },
  );

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
        /import \{[^}]*(parseScopeFilter|validateScope)[^}]*\} from '\.\.\/\.\.\/_shared\/scope\/scope\.ts'/,
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

  // A handler may hand part of its work to a module-private delegate that owns
  // its own scope predicate. `handleRemove` does: the `?org=` form is served by
  // `removeOrgOwned`, whose `p_scope` sits outside the `handleRemove` slice the
  // assertions above read — and the completeness scan below skips `remove.ts`
  // because the FILE is already listed. Guard the delegate explicitly: the call
  // site must feed it the validated binding, and inside it every scope
  // predicate must use its own parameter.
  const DELEGATED_SCOPE_PREDICATES: ReadonlyArray<
    readonly [string, string, string, string, string]
  > = [['remove.ts', 'handleRemove', 'removeOrgOwned', 'scopeParam', 'scope']];

  it.each(DELEGATED_SCOPE_PREDICATES)(
    '%s: %s only reaches %s with the validated scope',
    (file, caller, delegate, bound, param) => {
      const src = read(file);
      const callSite = handlerBody(src, caller).match(
        new RegExp(`${delegate}\\(([\\s\\S]*?)\\);`),
      );
      expect(callSite, `${caller} does not call ${delegate}`).not.toBeNull();
      expect(callSite![1]).toMatch(new RegExp(`${param}:\\s*${bound}\\b`));

      const delegateBody = handlerBody(src, delegate);
      const predicates = [
        ...delegateBody.matchAll(/p_scope:\s*([^,\n]+)/g),
        ...delegateBody.matchAll(/\.eq\(\s*'scope'\s*,\s*([^)]+?)\s*\)/g),
      ];
      expect(predicates.length, `${delegate} has no scope predicate to guard`).toBeGreaterThan(0);
      for (const m of predicates) {
        expect(m[1], `${delegate}: scope predicate ${m[1]} does not use ${param}`).toContain(param);
      }
    },
  );

  it('remove.ts validates the scope filter only on the natural-key form', () => {
    // `DELETE /memories/:id` addresses the row by id and never reads `?scope=`,
    // so validating it there would answer 400 for a value the route ignores —
    // a rejection this change does not intend. The guard is gated on the id
    // branch; the scope+key and `?org=` forms still go through it.
    const body = handlerBody(read('remove.ts'), 'handleRemove');
    expect(body).toMatch(/if\s*\(\s*!idParam\s*\)\s*\{[\s\S]{0,240}?parseScopeFilter\(/);
  });

  // A route whose scope filter lives in a shared reader is only guarded if BOTH
  // its transports actually go through that reader. Without this, moving one
  // entry point back to its own query would pass every assertion above.
  const DUAL_TRANSPORT_ROUTES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['list.ts', 'respondWithPage', ['handleList', 'handleListPost']],
    ['activity.ts', 'runActivity', ['handleActivity', 'handleActivityPost']],
    ['facets.ts', 'runFacets', ['handleFacets', 'handleFacetsPost']],
  ];

  it.each(DUAL_TRANSPORT_ROUTES)(
    '%s: both transports read through %s',
    (file, reader, entryPoints) => {
      const src = read(file);
      for (const fn of entryPoints) {
        expect(handlerBody(src, fn), `${fn} does not call ${reader}`).toContain(`${reader}(`);
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
    // Retention-policy handlers (`policies.ts`, `groom.ts`, `protect.ts`): every
    // `p_scope:` in these three reaches a SECURITY DEFINER RPC argument
    // (`lorekit_policy_create`/`lorekit_groom_candidates`/`lorekit_groom_run`/
    // `lorekit_memory_protect`), never a PostgREST `.eq()`/`.or()` filter
    // string — so the injection-avoidance charset check `parseScopeFilter`
    // exists for does not apply (RPC arguments are bound as parameters, not
    // interpolated into a filter grammar). Grammar + case handling is done by
    // the request-boundary `ScopeSchema` zod transform instead (validates and
    // normalises, same as every other MCP-style tool input in this catalog).
    listed.add('policies.ts');
    listed.add('groom.ts');
    listed.add('protect.ts');
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
