import { expect, test } from '../support/fixtures';

/**
 * Signed-out journeys across pages — the paths a first-time visitor takes.
 * Per-page rendering is pages.e2e.ts's job; these check that pages connect.
 */

test('the landing page header leads to the docs and the blog', async ({ page }) => {
  await page.goto('/');
  const site = page.getByRole('navigation', { name: 'Site' });

  await site.getByRole('link', { name: 'Docs', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/docs/setup');
  await expect(page.getByRole('heading', { level: 1, name: 'Getting started', exact: true })).toBeVisible();

  await page.goBack();
  await page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Blog', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/blog');
  await expect(page.getByRole('heading', { level: 1, name: 'Blog', exact: true })).toBeVisible();
});

test('the landing page header leads to sign-in', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to LoreKit', exact: true })).toBeVisible();
});

test.describe('an unknown URL', () => {
  // Chromium logs the 404 document itself as a failed resource load.
  test.use({ allowedConsoleErrors: [/status of 404/] });

  test('shows the not-found page with a 404 status', async ({ page }) => {
    const response = await page.goto('/this-page-does-not-exist-e2e');
    expect(response?.status()).toBe(404);
    await expect(page.getByText('Page not found', { exact: true })).toBeVisible();
  });
});
