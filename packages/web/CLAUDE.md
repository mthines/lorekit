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
- **`public/llms.txt` is the agent-readable mirror of the product** (served at
  `/llms.txt`) — quickstart, MCP endpoint, tokens + permission matrix, tools,
  scopes, limits. This package OWNS it, and **every change to a user-visible
  capability updates it in the same PR** (the repo-wide rule is in the root
  [CLAUDE.md](../../CLAUDE.md#user-facing-docs-mandatory-on-every-change)).
  Unlike the MDX registries it has **no generator and no drift guard**, so
  nothing goes red when it rots — treat it as hand-maintained prose that must
  stay consistent with `src/content/docs/*.mdx`. Keep it terse and skimmable:
  it is read by agents under a token budget, not browsed.
