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
//     state: 'advisory'|'gating'|'retired',
//                                // advisory: reported, gates nothing.
//                                // gating: fails --strict. An entry may only
//                                // be `gating` if it has a `guard` — an
//                                // independent source that already asserts
//                                // the partnership. Without one, the entry
//                                // asserts only its own author's belief, and
//                                // `perf-index` / `error-code-doc` say as
//                                // much in their notes. Enforced in
//                                // obligations.test.mjs.
//                                // retired: not checked; kept for provenance.
//     cluster: string,          // the recurrence class this entry
//                                // instantiates (`./recurrence-clusters.mjs`).
//                                // Supplies the lesson key to cite, and
//                                // groups entries that share a root cause.
//     lessonKey?: string,       // an entry-specific memory key, overriding
//                                // its cluster's canonical one. Rare.
//     owner: string,            // who reviews this entry when it misfires.
//                                // An entry with no owner is cruft with a CI
//                                // job attached.
//     added: string,            // ISO date
//     reviewBy: string,         // ISO date. Memories expire; without this the
//                                // map is the one place in the system under
//                                // no decay pressure, and it accumulates the
//                                // way the lesson variants it replaced did.
//                                // Guard-less entries get a shorter horizon.
//     guard?: string,           // the existing CI spec/script that enforces
//                                // this partnership, if any
//     note?: string,            // why this entry exists / its limitations
//   }
//
// See `obligations-pure.mjs` for the matcher and the exact `{name}` grammar.
//
// The `edge-mirror` / `edge-mirror-core` rows below are a special case: they
// are GENERATED, one pair of rows per entry in `mirrorPairs`
// (`./mirror-pairs.mjs`, the single-source inventory shared with
// `packages/mcp-core/src/edge/edge-parity.spec.ts`), rather than hand-authored
// with a `{name}`-substituting glob. A glob assuming the edge copy mirrors
// mcp-core's directory structure false-positives whenever a real mirror
// flattens or renames it (e.g. `packages/mcp-core/src/auth/auth-token.ts` ↔
// the FLAT `supabase/functions/mcp/auth-token.ts`) — the exact-path
// reconstruction it would need to get right is simply not derivable from the
// two paths alone. Enumerating each KNOWN pair's real partner has no such
// assumption to violate. `checkObligations` already merges every map entry
// that shares an `id` into one reported bucket (see `obligations-pure.mjs`'s
// `byId` merge in the matcher), so the many generated rows below still
// surface as the two logical `edge-mirror` / `edge-mirror-core` entries.

import { mirrorPairs } from './mirror-pairs.mjs';

const EDGE_MIRROR_GUARD = 'packages/mcp-core/src/edge/edge-parity.spec.ts';

// One `{ match, obliges }` row PER KNOWN PAIR, in both directions — see the
// module-level note above for why this replaces a `{name}`-templated glob.
const EDGE_MIRROR_ENTRIES = mirrorPairs.flatMap(({ core, edge }) => [
  {
    id: 'edge-mirror',
    state: 'gating',
    owner: '@mthines',
    added: '2026-08-26',
    reviewBy: '2027-02-26',
    match: edge,
    obliges: [core],
    cluster: 'copies-a-claim',
    guard: EDGE_MIRROR_GUARD,
    note: 'An edge (Deno) module mirrored self-contained from mcp-core — edit one, mirror the other. Partner looked up from the shared mirror-pairs inventory, never reconstructed from an assumed-symmetric path.',
  },
  {
    id: 'edge-mirror-core',
    state: 'gating',
    owner: '@mthines',
    added: '2026-08-26',
    reviewBy: '2027-02-26',
    match: core,
    obliges: [edge],
    cluster: 'copies-a-claim',
    guard: EDGE_MIRROR_GUARD,
    note: 'The reverse direction of edge-mirror — a mcp-core source file changed, its known edge mirror (from the same mirror-pairs inventory) is the partner.',
  },
]);

export const SURFACE_PARTNER_MAP = [
  ...EDGE_MIRROR_ENTRIES,
  {
    id: 'tool-catalog',
    state: 'gating',
    owner: '@mthines',
    added: '2026-08-26',
    reviewBy: '2027-02-26',
    match: 'packages/schemas/src/shared/tool-catalog.ts',
    obliges: [
      'supabase/functions/mcp/tool-dispatch.generated.ts',
      'packages/cli/src/surfaces.generated.mjs',
      'packages/web/public/llms.txt',
      'run:pnpm nx generate:llms schemas',
    ],
    cluster: 'copies-a-claim',
    guard: 'packages/mcp-core/src/mcp-guards/tool-catalog-parity.spec.ts, scripts/codegen/gen-surfaces.mjs --check',
    note: 'The catalog is the single origin of the operation surface — every generated projection of it must be regenerated in the same commit.',
  },
  {
    id: 'llms-generated',
    state: 'gating',
    owner: '@mthines',
    added: '2026-08-26',
    reviewBy: '2027-02-26',
    match: ['packages/schemas/src/llms/template.md', 'packages/schemas/src/shared/tool-catalog.ts'],
    obliges: ['packages/web/public/llms.txt', 'run:pnpm nx generate:llms schemas'],
    cluster: 'copies-a-claim',
    guard: 'packages/schemas/src/llms/render.spec.ts',
    note: 'llms.txt is GENERATED — never hand-edited; the committed file must be what the generator produces from these two sources.',
  },
  {
    id: 'docs-section',
    state: 'gating',
    owner: '@mthines',
    added: '2026-08-26',
    reviewBy: '2027-02-26',
    match: 're:^packages/web/src/content/docs/[^/]+\\.mdx$',
    obliges: ['packages/web/src/lib/docs/sections.ts'],
    cluster: 'sibling-set',
    guard: 'packages/web/src/lib/docs/sections.spec.ts',
    note: 'A new/removed docs page needs its DOCS_SECTIONS entry, or the site index and the page itself drift apart.',
  },
  {
    id: 'plugin-skill',
    state: 'gating',
    owner: '@mthines',
    added: '2026-08-26',
    reviewBy: '2027-02-26',
    match: 'packages/cli/skill/**',
    obliges: ['run:node scripts/codegen/sync-plugin-skill.mjs', 'plugins/lorekit-claude/skills/**'],
    cluster: 'sibling-set',
    guard: 'scripts/codegen/sync-plugin-skill.mjs --check',
    note: 'The Claude plugin vendors a copy of every skill/* source — regenerate the mirror, never hand-edit it.',
  },
  {
    id: 'cli-flag-doc',
    state: 'advisory',
    owner: '@mthines',
    added: '2026-08-31',
    reviewBy: '2026-11-30',
    match: 'packages/cli/bin/lorekit.mjs',
    obliges: ['docs/cli.md', 'packages/cli/README.md', 'CLAUDE.md'],
    cluster: 'copies-a-claim',
    guard: null,
    note: 'The flag table and per-command help in bin/lorekit.mjs is the origin of every flag claim; docs/cli.md, the package README (prose AND its flag table) and CLAUDE.md each restate it. Found by running this command against its own changed-set while changing the meaning of --strict: nothing fired, because the map covered every generated surface and no hand-written one. A path proxy, not a content predicate — bin/lorekit.mjs changes for reasons unrelated to flags — so advisory by construction, like error-code-doc.',
  },
  {
    id: 'perf-index',
    state: 'advisory',
    owner: '@mthines',
    added: '2026-08-26',
    reviewBy: '2026-11-26',
    match: 're:^supabase/migrations/.*index.*\\.sql$',
    obliges: ['supabase/tests/migrations.test.sql'],
    cluster: 'sibling-set',
    guard: null,
    note: 'Convention only — a real gap. A new index migration has no automated nudge to add its coverage to the migrations test.',
  },
  {
    id: 'error-code-doc',
    state: 'advisory',
    owner: '@mthines',
    added: '2026-08-26',
    reviewBy: '2026-11-26',
    match: ['supabase/functions/mcp/mcp-handler.ts', 'packages/mcp-core/src/auth/account-wide-tools.ts'],
    obliges: [
      'docs/mcp-tools.md',
      'packages/schemas/src/llms/template.md',
      'packages/web/public/llms.txt',
    ],
    cluster: 'copies-a-claim',
    guard: null,
    note: 'A documented path-proxy, not a content predicate — obligations sees file paths, not diffs, so it cannot tell an error-const edit from an unrelated one in the same file and may over-flag. State is `advisory` for that reason: it is reported on every hit and gates nothing, not even under --strict (only --strict-all).',
  },
];
