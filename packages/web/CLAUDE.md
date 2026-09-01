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

## Data access goes through a REST endpoint, never a direct supabase-js query (REQUIRED)

**This is a hard requirement, not a preference.** Any data this dashboard reads
or writes to Postgres MUST go through a LoreKit REST **edge function**
(`src/lib/api/*`), typed end-to-end with `@lorekit/schemas`. Do NOT call an RPC
or `.from(<table>)` through supabase-js from a component, hook, or server action
to move product data. If you find yourself reaching for `createClient().from(…)`
or `.rpc(…)` for anything other than **auth**, stop and add an endpoint instead.

- **Why it is a rule.** Querying the table directly means re-implementing every
  predicate the REST handler already owns — tenant scope, the active/archived
  partition, the expiry filter, the keyset cursor, label containment quoting.
  Two implementations of one contract drift, and they did: the row-cap bug
  `GET /memories/scopes` was built to fix stayed live in the dashboard's scope
  tree, label catalog and Overview charts for months after the endpoint shipped.
- **A capability the dashboard needs becomes part of the PUBLIC contract.** When
  a view needs a filter, an aggregate, or a brand-new operation the API does not
  expose, you extend the surface — **all of**: a schema in `@lorekit/schemas`
  (+ its `./<name>` package export and `MIRRORED_SCHEMA_FILES` entry so the edge
  copy exists), a handler in a `supabase/functions/<fn>/`, an OpenAPI
  registration in `packages/schemas/src/openapi/spec.ts`, and SQL assertions in
  `supabase/tests/migrations.test.sql` — and only then call it from `src/lib/api`.
  You do not reach past the API with a private query.
- **The blog like counter is the worked example (and the one PUBLIC endpoint).**
  It could have been a two-line supabase-js RPC call; it is instead the `blog`
  edge function (`GET`/`POST /blog/likes`), consumed via `src/lib/api/blog-likes.ts`.
  It differs from every other route in one way only — it is unauthenticated (the
  blog is public and likes are anonymous), so it uses `publicRestFetch` (no token)
  instead of `restFetch`. Everything else is the same pattern: schema in
  `@lorekit/schemas/blog`, handler in `supabase/functions/blog/`, OpenAPI path,
  and `migrations.test.sql` §73. **Do not "simplify" it back to a direct RPC.**
- Reads that must aggregate over the whole account (counts, catalogs, activity)
  belong in Postgres behind an endpoint, never in a `select … limit N` plus a
  browser-side reduce: PostgREST truncates at its row cap with no error, so the
  rollup is quietly wrong for exactly the accounts that have the most data.
- The credential is the user's own Supabase session token
  (`lib/api/session-browser.ts` / `session-server.ts`), so RLS applies exactly as
  it did before. No service key, no API token. (The public `blog` endpoint sends
  no credential at all.)
- **Supabase-js stays** for exactly one thing plus a shrinking list: **auth**
  (sign-in, session, password), and the server actions covering surfaces the REST
  API does not expose yet (orgs, invites, tokens, audit log). Those server actions
  are the migration backlog, not a licence to add a new direct `.from(…)`/`.rpc(…)`
  read for product data — new surfaces get an endpoint.

## Conventions specific to this package

- **Theme:** dark-only, driven by CSS custom properties in
  `src/app/globals.css` (`--color-*`). Use the tokens, never raw hex.
- **Motion:** `motion/react` (not `framer-motion`). Respect
  `prefers-reduced-motion` — either `MotionConfig reducedMotion="user"` or lean
  on the global reduced-motion rule in `globals.css`.
- **Accessibility floor:** ≥24px hit targets — WCAG 2.2 AA "Target Size
  (Minimum)", which every `Button`/`IconButton` size clears (`sm` 32 / `md` 36 /
  `lg` 40). 44px is the AAA "Target Size (Enhanced)" target, not an AA floor: a
  full-width `lg` CTA meets it on width, so inline actions are not held to it.
  Also labelled landmarks, `aria-current` on active nav items, visible focus rings.
- **Public MDX content** lives in `src/content/{docs,blog}/*.mdx`, each with a
  single-source registry (`lib/{docs,blog}/sections.ts`) guarded against drift
  by a `sections.spec.ts`. Adding a page = drop the `.mdx` + add its registry
  entry.
- **`public/llms.txt` is GENERATED — never edit it.** It is the agent-readable
  mirror of the product (served at `/llms.txt`), and it is built by
  `packages/schemas/src/llms/generate.ts` from three sources: the editorial
  prose in `schemas/src/llms/template.md`, the MCP tool reference in
  `schemas/src/shared/tool-catalog.ts`, and the `title`/`description`/`order`
  frontmatter of `src/content/docs/*.mdx` (which is why every page needs all
  three fields — a page missing one fails the generator, not just
  `sections.spec.ts`). Regenerate with `pnpm nx generate:llms schemas`;
  `schemas/src/llms/render.spec.ts` fails when the committed file drifts from
  what the generator produces. The repo-wide obligation to update it lives in
  the root [CLAUDE.md](../../CLAUDE.md#user-facing-docs-mandatory-on-every-change).
  Keep the template terse: it is read by agents under a token budget, not browsed.
