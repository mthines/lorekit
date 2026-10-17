import { signInThroughTheForm } from '../support/auth';
import { HAS_AUTH_BACKEND } from '../support/env';
import { expect, test } from '../support/fixtures';

test('the login page offers GitHub, email and magic-link sign-in', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Continue with GitHub', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Or email me a magic link', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Continue with email', exact: true }).click();
  await expect(page.locator('#lk-email')).toBeVisible();
  await expect(page.locator('#lk-password')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Forgot password?', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue with email', exact: true })).toBeVisible();
});

test.describe('signing in with a wrong password', () => {
  // The auth endpoint answers 400 for bad credentials; Chromium logs that
  // failed request as a console error.
  test.use({ allowedConsoleErrors: [/status of 400/, /auth\/v1\/token/] });

  test('shows an error and stays on /login', async ({ page }) => {
    test.skip(!HAS_AUTH_BACKEND, 'a local build with no Supabase behind it cannot answer a sign-in');
    await signInThroughTheForm(page, `nobody-${Date.now()}@lorekit.test`, 'definitely-not-the-password-1A!');
    await expect(page.locator('form').getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === '/login');
  });
});
