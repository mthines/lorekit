# @lorekit/web — Agent Context

The Next.js 15 dashboard (Vercel). Public marketing/docs/blog surfaces plus the
authenticated dashboard. See the root [CLAUDE.md](../../CLAUDE.md) for the wider
architecture, and [docs/](../../docs/README.md) for deployment, OTel, and Storybook.

---

## Code should be easy to understand

Readability is a hard requirement here, not a nicety — this package is read by
humans and agents alike, and the UI teaches users the product.

- **Prefer clarity over cleverness.** Guard clauses over nesting, domain nouns
  over abbreviations, one responsibility per function. Keep the functional
  core / impure shell split the codebase already uses (pure logic in `lib/*.ts`
  with a co-located `.spec.ts`; effects in components/server actions).
- **Comments explain WHY, not WHAT.** The diff shows what changed.

### Code blocks in user-facing content MUST be syntax-highlighted

Any fenced code block rendered to a user — every `/docs` and `/blog` MDX page —
**must** be syntax-highlighted so it is easy to scan and understand. This is
wired up once and shared, so you get it for free:

- Highlighting is [Shiki](https://shiki.style) via the shared config in
  **`src/lib/mdx/rehype-shiki.ts`**, added to BOTH MDX pipelines
  (`src/lib/docs/mdx-render-options.ts` and `src/lib/blog/mdx-render-options.ts`).
  It runs at build/serialize time, so pages ship pre-coloured HTML with **zero
  client-side JS**.
- **Always tag a fence with its language** (` ```ts `, ` ```json `, ` ```bash `,
  ` ```yaml `, …) so Shiki can highlight it. An untagged fence falls back to
  plain, uncoloured text (`fallbackLanguage: 'text'`) — correct, but harder to
  read, so don't rely on it.
- The app is dark-only; Shiki uses the `github-dark-default` theme with its
  background stripped so blocks keep the app's `--color-bg-elevated` (matching
  inline code). Don't add a second highlighter or a per-page theme — edit the
  shared config so `/docs` and `/blog` can never diverge.

---

## Data fetching goes through LoreKit's REST API, never PostgREST

The dashboard is a **client of its own API**. Memory reads and writes call the
`memories` edge function (`src/lib/api/`), typed end-to-end with
`@lorekit/schemas`; they do NOT query the `memories` table through supabase-js.

- Why: querying the table directly means re-implementing predicates the REST
  handlers already own — tenant scope, the active/archived partition, the expiry
  filter, the keyset cursor, label containment quoting. Two implementations of
  one contract drift, and they did: the row-cap bug `GET /memories/scopes` was
  built to fix stayed live in the dashboard's scope tree, label catalog and
  Overview charts for months after the endpoint shipped.
- **A capability the dashboard needs becomes part of the public contract.** If a
  view needs a filter or an aggregate the API does not expose, extend the
  endpoint (schema in `@lorekit/schemas`, handler, OpenAPI, SQL assertions) —
  do not reach past it with a private query.
- Reads that must aggregate over the whole account (counts, catalogs, activity)
  belong in Postgres behind an endpoint, never in a `select … limit N` plus a
  browser-side reduce: PostgREST truncates at its row cap with no error, so the
  rollup is quietly wrong for exactly the accounts that have the most data.
- The credential is the user's own Supabase session token
  (`lib/api/session-browser.ts` / `session-server.ts`), so RLS applies exactly as
  it did before. No service key, no API token.
- **Supabase-js stays** for what it is actually for: auth (sign-in, session,
  password) and the server actions covering surfaces the REST API does not
  expose yet (orgs, invites, tokens, audit log).

## Every query hook consumes `signal`, and every request has a deadline

A React Query hook in `lib/queries/*` MUST take `signal` from the query-function
context and a request MUST be able to time out. Both are load-bearing, and each
one on its own is not enough.

- **`queryFn: ({ signal }) => …` — destructured, so it is CONSUMED.** React Query
  cancels a query when its last observer goes away *only* if the function
  touched the signal; otherwise an abandoned fetch keeps `fetchStatus:
  'fetching'` until it settles, or forever if it never does. This is not
  hypothetical bookkeeping — a hook whose key encodes filter state mints a new
  query per interaction and abandons the previous one mid-flight, which is how
  the Lore Explorer's filter bar wedged the header's activity indicator.
- **A server action is no excuse.** `listMemories` and friends cannot take an
  `AbortSignal` (it is not serialisable), but consuming the signal still works:
  React Query reverts the query's state on cancel regardless of what the promise
  goes on to do. `await` the action, then `if (signal.aborted) throw new
  DOMException('Aborted', 'AbortError')` to discard a reply that raced the
  cancel. Do not skip the signal because "the action ignores it anyway".
- **`restFetch` bounds every request at `REST_TIMEOUT_MS` (30s)** and composes
  the caller's signal with that deadline by hand — NOT with `AbortSignal.any`,
  which Safari shipped only in 17.4. A `fetch` has no deadline of its own, so a
  connection that is accepted and then goes quiet leaves a promise nothing ever
  settles. Never add a call path that bypasses it.
- **Match the file's existing options.** Every hook in `lib/queries/lore.ts`
  passes `retry: retryUnlessSignedOut` — being signed out is not transient, and
  an abandoned page retrying in the background is work nobody asked for against
  an answer nobody will read. A hook whose key space is large and mostly
  transitional (one entry per intermediate filter combination) should shorten
  `gcTime` from the 5-minute client default, and a list that is REFINED rather
  than replaced wants `placeholderData: keepPreviousData` so the user is not
  dropped back to skeletons on every click.

## Conventions specific to this package

- **Theme:** dark-only, driven by CSS custom properties in
  `src/app/globals.css` (`--color-*`). Use the tokens, never raw hex.
- **Motion:** `motion/react` (not `framer-motion`). Respect
  `prefers-reduced-motion` — either `MotionConfig reducedMotion="user"` or lean
  on the global reduced-motion rule in `globals.css`.
- **Accessibility floor:** ≥24px hit targets (44px for primary actions),
  labelled landmarks, `aria-current` on active nav items, visible focus rings.
- **Public MDX content** lives in `src/content/{docs,blog}/*.mdx`, each with a
  single-source registry (`lib/{docs,blog}/sections.ts`) guarded against drift
  by a `sections.spec.ts`. Adding a page = drop the `.mdx` + add its registry
  entry.
- **`public/llms.txt` is GENERATED — never edit it.** It is the agent-readable
  mirror of the product (served at `/llms.txt`), and it is built by
  `packages/schemas/src/llms/generate.ts` from three sources: the editorial
  prose in `schemas/src/llms/template.md`, the MCP tool reference in
  `schemas/src/tool-catalog.ts`, and the `title`/`description`/`order`
  frontmatter of `src/content/docs/*.mdx` (which is why every page needs all
  three fields — a page missing one fails the generator, not just
  `sections.spec.ts`). Regenerate with `pnpm nx generate:llms schemas`;
  `schemas/src/llms/render.spec.ts` fails when the committed file drifts from
  what the generator produces. The repo-wide obligation to update it lives in
  the root [CLAUDE.md](../../CLAUDE.md#user-facing-docs-mandatory-on-every-change).
  Keep the template terse: it is read by agents under a token budget, not browsed.
