# Website e2e specs

Every `## Spec` block in this folder is a Playwright test. Write Markdown; no
TypeScript needed. The format is aw-tester's `WHEN`/`THEN` grammar, the same
one a `/ui-verify` PR block uses (`<!-- ui-verify:v1 -->`), so a spec moves
between a PR and this suite unchanged.

## Add a test

Append a block to any `*.md` file here (or add a new file):

```markdown
## Spec 29: Settings › Billing renders
url: /settings/billing
preconditions:
  - User is signed in (handled by the e2e auth setup)
flow:
  - WHEN page loads
    THEN {role: "heading", name: "Billing"} is visible
```

Then run it:

```bash
cd packages/web-e2e
npx playwright test -g "Billing"          # against a local build (see docs/smoke-tests.md)
pnpm nx test web-e2e                      # parse check + page coverage, no browser
```

A new page under `packages/web/src/app` with no spec fails `nx test web-e2e`
(and so the PR) until a spec visits it.

## The grammar

```text
## Spec <id>: <what a user does or sees>
url: <path to open>
persist: critical-path                    (optional, ignored here)
preconditions:                            (optional)
  - <free text>
flow:
  - WHEN <action>
    THEN <assertion>
    AND <assertion>
  - CAPTURE "<label>" [fullPage]          (a screenshot attached to the report)
```

| Actions (`WHEN`) | Assertions (`THEN` / `AND`) |
| --- | --- |
| `page loads` | `{…} is visible` |
| `{…} is clicked` | `{…} is not visible` |
| `{…} is filled with "text"` | `{…} has aria-selected: true` (any attribute) |
| `{…} is pressed with "Enter"` | `network: GET /path returned 200` |
| `{…} is checked` / `{…} is hovered` | |

Locators, most robust first:

| Form | Matches |
| --- | --- |
| `{role: "button", name: "Save"}` | the accessible role + name (exact; add `exact: false` for a substring, or use `/regex/`) |
| `{label: "Email address"}` | a form field by its label |
| `{placeholder: "Search…"}` | an input by its placeholder |
| `{text: "Page not found"}` | visible text |
| `{testid: "save-draft"}` | `data-testid` — the escape hatch |

Never a CSS selector, `nth-child` or XPath. A locator that matches two
elements fails the step: name the instance (the grammar has no way to scope
to a container, so such a flow goes in `src/journeys/*.e2e.ts`).

Preconditions are free text, and two phrasings change how a spec runs:

| Precondition | Effect |
| --- | --- |
| `User is signed in …` (or `logged in`) | Runs signed in, as the e2e test user. Its url also gets a generated check that a signed-out visitor is sent to `/login?next=<url>`. |
| `Not on production: <why>` (or `preview` / `local`) | Skipped on that target, with the reason in the report. |

Every test also fails on an uncaught exception, a `console.error` or a
same-origin 5xx, so a page that shows its heading but throws underneath still
fails.

What the grammar has and this runner refuses — loudly, with the line number,
never as a silent pass: `semantic:` (needs an LLM judge), `continues-from:`
(tests run isolated and in parallel), and `Format: intent` (import it first).

## Moving specs to and from ui-verify

```bash
cd packages/web-e2e

# A PR's ui-verify block → a spec file here
pnpm spec:import --pr 742                  # writes specs/pr-742.md
pnpm spec:import --file some-spec.md       # a block or spec saved to a file

# The routes aw-tester compiled when a ui-verify intent spec passed
pnpm spec:import --routes ../../.agent/<branch>/.aw-tester/routes

# Specs here → a block to paste into a PR description for /ui-verify run
pnpm spec:export specs/journeys.md
```

- A **v1 (grammar) block** imports verbatim.
- A **v2 (intent) block** imports as a draft: `url:`, preconditions and
  network outcomes translate, and every step and remaining outcome becomes a
  `# TODO(ui-verify import)` line. The parser refuses TODO lines, so the draft
  fails `nx test web-e2e` until you write its `WHEN`/`THEN` lines. The fastest
  way to fill them: run the intent spec once with `/ui-verify run`, then import
  the route aw-tester compiled (`--routes`).
- **Exported** specs run under ui-verify's preview target, which is signed in,
  so a signed-out-only check (the login page, say) is better left out of a PR
  block.
