import { NO_USER_REASON, USER_SOURCE } from '../support/env';
import { expect, test } from '../support/fixtures';

/** Signed-in journeys through the app shell. Runs in the `signed-in` project. */

test.describe('the signed-in app shell', () => {
  test.skip(!USER_SOURCE, NO_USER_REASON);

  test('keeps the session across a reload', { tag: '@signed-in' }, async ({ page }) => {
    await page.goto('/lore');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL((url) => url.pathname === '/lore');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  });

  test('navigates between Explorer, Insights and Settings', { tag: '@signed-in' }, async ({ page }) => {
    await page.goto('/lore');
    const nav = page.getByRole('navigation', { name: 'Main navigation' }).first();

    await nav.getByRole('link', { name: 'Insights', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/insights');
    await expect(page.getByRole('heading', { level: 1, name: 'Insights', exact: true })).toBeVisible();

    await nav.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname.startsWith('/settings'));
    await expect(page.getByRole('heading', { level: 1, name: 'Settings', exact: true })).toBeVisible();

    await nav.getByRole('link', { name: 'Explorer', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/lore');
    await expect(page.getByRole('heading', { level: 1, name: 'Lore Explorer', exact: true })).toBeVisible();
  });

  test('sends a signed-in visitor away from /login', { tag: '@signed-in' }, async ({ page }) => {
    await page.goto('/login?next=%2Fsettings%2Fuser');
    await expect(page).toHaveURL((url) => url.pathname === '/settings/user');
    await expect(page.getByRole('heading', { level: 2, name: 'User', exact: true })).toBeVisible();
  });
});
