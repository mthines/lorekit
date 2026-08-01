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
