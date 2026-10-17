import type { Page } from '@playwright/test';
import { ROUTES, visitPath, type RouteCheck } from './routes';
import { NO_USER_REASON, TARGET, USER_SOURCE } from './support/env';
import { expect, test } from './support/fixtures';

/**
 * One block of tests per entry in routes.ts. Nothing to edit here when a page
 * is added — add the entry to routes.ts instead.
 */

function heading(page: Page, r: RouteCheck) {
  return page.getByRole('heading', {
    level: r.heading.level,
    name: r.heading.name,
    exact: typeof r.heading.name === 'string',
  });
}

async function expectPageRenders(page: Page, r: RouteCheck) {
  const response = await page.goto(visitPath(r));
  expect(response?.status() ?? 0, `HTTP status for ${visitPath(r)} (0 = no response)`).toBeGreaterThan(0);
  expect(response?.status() ?? 0, `HTTP status for ${visitPath(r)}`).toBeLessThan(400);
  if (r.landsOn) {
    const landsOn = r.landsOn;
    await expect(page).toHaveURL((url) => url.pathname === landsOn);
  }
  await expect(heading(page, r)).toBeVisible();
}

for (const r of ROUTES) {
  const skipReason = r.skipOn?.[TARGET];

  test.describe(`page ${r.route}`, () => {
    test.use({ allowedConsoleErrors: r.allowConsoleErrors ?? [] });

    if (r.access === 'public') {
      test('renders for a signed-out visitor', async ({ page }) => {
        test.skip(Boolean(skipReason), skipReason);
        await expectPageRenders(page, r);
      });
      return;
    }

    // Free coverage of the auth gate for every dashboard page: no credentials
    // needed, so this runs on every PR.
    test('sends a signed-out visitor to /login', async ({ page }) => {
      const path = visitPath(r);
      await page.goto(path);
      await expect(page).toHaveURL(
        (url) => url.pathname === '/login' && url.searchParams.get('next') === path,
      );
      await expect(page.getByRole('heading', { level: 1, name: 'Sign in to LoreKit', exact: true })).toBeVisible();
    });

    test.describe('signed in', () => {
      // Describe-level, so it is decided before a browser context (and the
      // saved session it loads) is created.
      test.skip(!USER_SOURCE, NO_USER_REASON);

      test('renders for a signed-in user', { tag: '@signed-in' }, async ({ page }) => {
        test.skip(Boolean(skipReason), skipReason);
        await expectPageRenders(page, r);
      });
    });
  });
}
