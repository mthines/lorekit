import path from 'node:path';
import type { Spec } from './spec/grammar.cjs';
import { urlPath } from './spec/grammar.cjs';
import { loadSpecs } from './spec/load';
import { expectedErrorStatuses, runSpec } from './spec/run';
import { NO_USER_REASON, TARGET, USER_SOURCE } from './support/env';
import { allowing, expect, test } from './support/fixtures';

/**
 * Turns every `## Spec` block in packages/web-e2e/specs/*.md into a test.
 * Nothing to edit here to add a test — add a spec (specs/README.md).
 *
 *   no "signed in" precondition → one test, signed out (the `public` project)
 *   "User is signed in …"       → one test, signed in (the `signed-in` project,
 *                                  skipped with the reason when no test user is
 *                                  configured), PLUS a generated check that a
 *                                  signed-out visitor to that url is sent to
 *                                  /login?next=<url> — the auth gate, for free
 */

const SPECS_DIR = path.join(__dirname, '..', 'specs');
const specs = loadSpecs(SPECS_DIR);

/** A known error the spec itself asserts (a 404 page logs its own 404) is not a page problem. */
const allowedFor = (spec: Spec) => expectedErrorStatuses(spec).map((s) => new RegExp(`status of ${s}\\b`));

for (const spec of specs) {
  const skipReason = spec.skipOn[TARGET];

  test.describe(`${spec.file} › ${spec.title}`, () => {
    test.use({ allowedConsoleErrors: allowing(allowedFor(spec)) });

    if (!spec.signedIn) {
      test(`signed out — ${spec.url}`, async ({ page }, testInfo) => {
        test.skip(Boolean(skipReason), skipReason);
        await runSpec(page, spec, testInfo);
      });
      return;
    }

    test.describe(() => {
      // Describe-level, so it is decided before the context (and the saved
      // session it loads) is created.
      test.skip(!USER_SOURCE, NO_USER_REASON);
      test(`signed in — ${spec.url}`, { tag: '@signed-in' }, async ({ page }, testInfo) => {
        test.skip(Boolean(skipReason), skipReason);
        await runSpec(page, spec, testInfo);
      });
    });
  });
}

// The auth gate: every url a signed-in spec visits must turn a signed-out
// visitor away to /login, carrying the url back in ?next=. /login itself is the
// exception — signed out, it is simply the page.
const gated = [...new Set(specs.filter((s) => s.signedIn && urlPath(s.url) !== '/login').map((s) => s.url))];

test.describe('auth gate', () => {
  for (const url of gated) {
    test(`${url} sends a signed-out visitor to /login`, async ({ page }) => {
      await page.goto(url);
      await expect(page).toHaveURL((u) => u.pathname === '/login' && u.searchParams.get('next') === url);
      await expect(page.getByRole('heading', { level: 1, name: 'Sign in to LoreKit', exact: true })).toBeVisible();
    });
  }
});
