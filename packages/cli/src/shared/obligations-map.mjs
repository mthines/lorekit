// The Surface-Partner Map — a declarative registry of known, path-keyed file
// partnerships in this repo. This is slice 1 of the fix for a structural
// retrieval leak the `dash0-dev` review bot repeatedly flags: a fix to one
// surface (a mirrored module, a doc that copies a claim, a generated artifact,
// a required test assertion) leaves its PARTNER surface stale, because the
// lessons documenting each partnership are retrieved lexically (FTS +
// recency) and rarely surface at edit time for the exact file just touched.
//
// Every entry here is SEEDED from an existing, real CI guard — it duplicates
// no enforcement, it just makes the partnership visible to `lorekit
// obligations` (see `../commands/obligations.mjs`) BEFORE the guard runs, so
// a human or agent can sweep the partner in the same commit instead of
// discovering the gap in review. `guard` names that real spec/script per
// entry; entries with no automated guard (`perf-index`, `error-code-doc`) say
// so explicitly rather than implying one exists.
//
// Entry schema:
//   {
//     id: string,               // stable identifier
//     match: string|string[],   // repo-relative glob(s); a `re:` prefix is
//                                // used as a verbatim RegExp; `**/{name}` or
//                                // `{name}` binds the matched module's
//                                // relative path (dirs + stem, extension
//                                // stripped) for reuse in `obliges`
//     obliges: Array<string | string[]>,
//                                // each element is EITHER a required partner
//                                // path/glob (may reuse `{name}`), a
//                                // `run:<action>` advisory (never gates
//                                // --strict), OR an array of alternative
//                                // paths satisfied by ANY ONE of them (used
//                                // when a name-derived module's real partner
//                                // could live under either of two sibling
//                                // directories)
//     lessonKey: string,        // canonical memory key to cite
//     guard?: string,           // the existing CI spec/script that enforces
//                                // this partnership, if any
//     note?: string,            // why this entry exists / its limitations
//   }
//
// See `obligations-pure.mjs` for the matcher and the exact `{name}` grammar.

// The flagship recurrence class: a partner copies a CLAIM (a mirrored
// module's behavior, a generated artifact's content, a documented mechanism)
// and goes stale when the source changes. Cited by every entry below whose
// obligation is "this partner copies what you just changed."
const COPIES_A_CLAIM_LESSON =
  'implement-suggestion-lessons::a-mechanism-clause-you-correct-in-the-pr-body-must-be-corrected-in-every-doc-that-copies-it';

// The registered-everywhere / sibling-set recurrence class: adding or moving
// something that a SET of surfaces enumerates (a doc listing every command,
// a generated mirror listing every file) re-flags every surface that lists
// the set and now has a hole.
const SIBLING_SET_LESSON = 'aw-lessons::docs-drift-grep-must-search-names-not-invocation';

export const SURFACE_PARTNER_MAP = [
  {
    id: 'edge-mirror',
    match: ['supabase/functions/_shared/**/{name}.ts', 'supabase/functions/mcp/**/{name}.ts'],
    obliges: ['packages/mcp-core/src/**/{name}.ts'],
    lessonKey: COPIES_A_CLAIM_LESSON,
    guard: 'packages/mcp-core/src/edge/edge-parity.spec.ts',
    note: 'An edge (Deno) module mirrored self-contained from mcp-core — edit one, mirror the other.',
  },
  {
    id: 'edge-mirror-core',
    match: 'packages/mcp-core/src/**/{name}.ts',
    obliges: [['supabase/functions/_shared/**/{name}.ts', 'supabase/functions/mcp/**/{name}.ts']],
    lessonKey: COPIES_A_CLAIM_LESSON,
    guard: 'packages/mcp-core/src/edge/edge-parity.spec.ts',
    note: 'The reverse direction of edge-mirror — a mcp-core source file changed, its edge mirror (either _shared/ or mcp/, never predictably both) is the partner.',
  },
  {
    id: 'tool-catalog',
    match: 'packages/schemas/src/shared/tool-catalog.ts',
    obliges: [
      'supabase/functions/mcp/tool-dispatch.generated.ts',
      'packages/cli/src/surfaces.generated.mjs',
      'packages/web/public/llms.txt',
      'run:pnpm nx generate:llms schemas',
    ],
    lessonKey: COPIES_A_CLAIM_LESSON,
    guard: 'packages/mcp-core/src/mcp-guards/tool-catalog-parity.spec.ts, scripts/codegen/gen-surfaces.mjs --check',
    note: 'The catalog is the single origin of the operation surface — every generated projection of it must be regenerated in the same commit.',
  },
  {
    id: 'llms-generated',
    match: ['packages/schemas/src/llms/template.md', 'packages/schemas/src/shared/tool-catalog.ts'],
    obliges: ['packages/web/public/llms.txt', 'run:pnpm nx generate:llms schemas'],
    lessonKey: COPIES_A_CLAIM_LESSON,
    guard: 'packages/schemas/src/llms/render.spec.ts',
    note: 'llms.txt is GENERATED — never hand-edited; the committed file must be what the generator produces from these two sources.',
  },
  {
    id: 'docs-section',
    match: 're:^packages/web/src/content/docs/[^/]+\\.mdx$',
    obliges: ['packages/web/src/lib/docs/sections.ts'],
    lessonKey: SIBLING_SET_LESSON,
    guard: 'packages/web/src/lib/docs/sections.spec.ts',
    note: 'A new/removed docs page needs its DOCS_SECTIONS entry, or the site index and the page itself drift apart.',
  },
  {
    id: 'plugin-skill',
    match: 'packages/cli/skill/**',
    obliges: ['run:node scripts/codegen/sync-plugin-skill.mjs', 'plugins/lorekit-claude/skills/**'],
    lessonKey: SIBLING_SET_LESSON,
    guard: 'scripts/codegen/sync-plugin-skill.mjs --check',
    note: 'The Claude plugin vendors a copy of every skill/* source — regenerate the mirror, never hand-edit it.',
  },
  {
    id: 'perf-index',
    match: 're:^supabase/migrations/.*index.*\\.sql$',
    obliges: ['supabase/tests/migrations.test.sql'],
    lessonKey: SIBLING_SET_LESSON,
    guard: null,
    note: 'Convention only — a real gap. A new index migration has no automated nudge to add its coverage to the migrations test.',
  },
  {
    id: 'error-code-doc',
    match: ['supabase/functions/mcp/mcp-handler.ts', 'packages/mcp-core/src/auth/account-wide-tools.ts'],
    obliges: [
      'docs/mcp-tools.md',
      'packages/schemas/src/llms/template.md',
      'packages/web/public/llms.txt',
    ],
    lessonKey: COPIES_A_CLAIM_LESSON,
    guard: null,
    note: 'A documented path-proxy, not a content predicate — obligations sees file paths, not diffs, so it cannot tell an error-const edit from an unrelated one in the same file and may over-flag. Advisory only (never gates unless --strict, and even then it is one signal among several).',
  },
];
