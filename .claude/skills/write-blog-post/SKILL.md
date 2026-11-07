---
name: write-blog-post
description: >
  Writes, critically reviews, illustrates, and ships a post for the LoreKit
  blog (packages/web/src/content/blog) end to end: researches the topic,
  checks every LoreKit claim against the code and every outside claim against
  sources, drafts in the house voice, runs a skeptic's review and rewrites for
  plain, strong language, draws SVG figures in the blog's figure style,
  registers the post, and verifies it compiles. Triggers on "write a blog
  post", "new blog post", "draft a post about", "review this blog post",
  "add graphics to the post", "/write-blog-post".
argument-hint: '<topic or slug> [--review-only] [--figures-only]'
license: MIT
metadata:
  author: mthines
  version: '1.0.0'
  workflow_type: applied
  tags:
    - blog
    - content
    - mdx
    - svg
    - lorekit
---

# Write a blog post

A LoreKit blog post is a public claim about how the product works and how it
compares to other tools. Readers include people who build those tools. One
wrong claim about the code, or about a competitor, costs more credibility than
the post earns. So this skill is mostly about **checking**, and only partly
about writing.

Run the phases in order. `--review-only` starts at Phase 4 on an existing post.
`--figures-only` runs Phase 5 alone.

## Files you will touch

| Path | What it is |
| --- | --- |
| `packages/web/src/content/blog/<slug>.mdx` | The post. The slug is the URL and the filename |
| `packages/web/src/lib/blog/sections.ts` | The registry. One entry per post: `id` = slug, `label` = title, `summary` = description, character for character |
| `packages/web/public/blog/<name>.svg` | Figures, referenced as `/blog/<name>.svg` |

`sections.spec.ts` fails when the registry and the frontmatter disagree, and
when the `order` values don't match the registry order.

## Phase 1 — Orient

1. Read **every** existing post's frontmatter and at least two full posts.
   Learn the voice (see [Voice](#voice)) and, above all, **what has already
   been said**. A new post must not repeat an earlier one. Link to it instead.
2. Read `sections.ts` to find the next `order` (the highest existing value + 1).
3. Settle the angle in one sentence before writing anything. If it overlaps
   an existing post, find the part that's new.

## Phase 2 — Research

**LoreKit claims: check the code, not the docs or your memory.** For every
behaviour the post states, open the implementation and note the file. Claims
that drifted in earlier posts, and are worth checking every time:

- **TTL / expiry.** Read the latest `memory_write` in `supabase/migrations/`
  and `packages/cli/src/store/local.mjs`. Memories are permanent by default.
  Only a write that carries a TTL (or a config default) resets the countdown.
  A read never extends anything.
- **Scope grammar.** `packages/mcp-core/src/scope/scope.ts` defines exactly
  what is accepted. For example, `repo::` takes `owner/repo` only.
- **On-disk format.** `packages/cli/src/store/format.mjs`: which fields
  exist, and what survives a rewrite. Unknown fields are dropped.
- **What the session-start digest includes.** `packages/cli/src/core/lessons.mjs`
  (`isGeneralLesson`).
- **Limits.** `MAX_VALUE_BYTES` in `packages/schemas/src/domain/memory.ts`,
  the memory cap and the rate limit in `docs/limits.md`.
- **Inferred fields.** `kind`/`host` are inferred only from `loop::` tags.
  Show realistic values in examples, not what you assume a field holds.

**Outside claims: search, cite, and look for competitors.** Use WebSearch or
WebFetch for every statement about another tool. Keep the source URLs; the
summary you give the user must list them. Always search explicitly for
**existing proposals or standards** in the post's area. Leaving out a
competing effort is the first thing a critic will point to.

**Never invent first-person experience** for the author ("on my laptop…",
"I tried X last week"). Write it as a general or hypothetical case unless the
user has told you it's true.

## Phase 3 — Draft

Frontmatter (every field required, and the same order as other posts):

```yaml
---
title: "…"                 # must equal sections.ts `label`
description: "…"           # must equal sections.ts `summary`
date: "YYYY-MM-DD"         # a future date keeps it a draft: hidden in prod, visible on previews
author: "Mads Thines"
readingMinutes: 10         # about 220 words a minute, rounded
tags: ["…"]
order: 5                   # next integer, matching the registry position
keywords: ["…"]
---
```

Then add the registry entry at the end of `BLOG_SECTIONS`. Python's `repr()`
picks quote styles that break TypeScript; edit the entry by hand, or check for
the trailing comma afterwards.

Structure that works for this blog:

- Open with something concrete the reader recognises, not a thesis.
- Use `##` sections with plain, specific headings (they become the table of contents).
- Every fenced code block gets a language tag (`bash`, `json`, `ts`, `text`,
  `markdown`, `yaml`). Shiki highlights only tagged blocks.
- Use internal links (`/blog/<slug>`, `/docs/<page>`) rather than repeating material.
- Always write the concrete MCP endpoint, never a `<ref>` placeholder.
- End with something the reader can do, usually `npx @lorekit/cli install`.

## Phase 4 — Critical review and rewrite

Do this as a separate pass, as if someone else wrote the draft. Produce a
findings list for the user, then fix the post.

1. **Compare to the code.** Re-check each LoreKit claim against Phase 2. Look
   for overstatement ("by default", "always", "never", "lossless"): those are
   the words that turn out to be false.
2. **Compare to the industry.** Is every tool described fairly and currently?
   Is any competing proposal missing? Does the post claim something is
   original when someone else already did it?
3. **Write the skeptic's objections.** List the five or six things a sharp
   critic would say: conflict of interest, "X already solves this", security,
   scale, "yet another standard". Answer the strong ones in the post, in a
   section or inline. Concede where the critic is right. A post that admits
   its weak points is more convincing than one that hides them.
4. **Rewrite for plain, strong language.**
   - One idea per sentence. Short sentences. Active voice.
   - Concrete nouns and real examples instead of abstractions.
   - Cut hedges ("quite", "arguably", "it seems") and empty intensifiers.
   - Turn run-on lists in prose into bullets.
   - Bold at most one phrase per section: the thing to remember.
   - Say "I'm not sure" plainly where it's true. Don't invent certainty.
5. Update `description` and the registry `summary` together if the angle moved.

## Phase 5 — Figures

Each post usually has 2–4 figures, one per idea that is easier to see than to
read: a comparison, a timeline, a hierarchy, a data shape. Don't draw a figure
that only repeats a table.

Follow [references/figure-style.md](./references/figure-style.md) exactly:
the palette, fonts, background, `role="img"` with a full `aria-label`, and the
`<figure>` markup with `alt`, `width`, `height` and a `<figcaption>` that
states the takeaway, not just the subject.

Then **look at every figure** before you embed it:

```bash
node .claude/skills/write-blog-post/scripts/render-svg.cjs "$SCRATCH" packages/web/public/blog/<name>.svg
```

Read the PNG and check for text overflowing a box, labels colliding with
marks, and glyphs rendering in the wrong colour. Fix, re-render, and look
again. Validate the XML with `xmllint --noout`.

## Phase 6 — Verify

```bash
cd packages/web
npx vitest run src/lib/blog                      # registry drift, order, dates, render
```

The render spec compiles only one fixed post. Compile the new one through the
real pipeline too, with a throwaway copy that you delete afterwards:

```bash
sed 's|self-healing-agents.mdx|<slug>.mdx|' src/lib/blog/mdx-render.spec.ts > src/lib/blog/tmp-post.spec.ts
npx vitest run src/lib/blog/tmp-post.spec.ts; rm src/lib/blog/tmp-post.spec.ts
```

Install dependencies first in a fresh sandbox (`pnpm install --frozen-lockfile`).

## Phase 7 — Ship

- Commit the post, the registry entry and the figures together. The blog is
  not part of `llms.txt`, so the PR description should say in one line that
  no other docs needed changes.
- Follow the repo's PR workflow (root `CLAUDE.md`) only if the user asks for a PR.
- Report to the user: the post's URL path, its date (and whether that makes it
  a draft), the review findings you fixed, anything you couldn't verify, and
  the source links.

## Voice

- First person singular, as the author: curious and direct, and open about
  what's uncertain.
- Name the problem in the reader's terms before naming LoreKit.
- Invite argument at the end. The blog's posts treat design as an open question.
- No marketing superlatives. Let a concrete example make the point.
