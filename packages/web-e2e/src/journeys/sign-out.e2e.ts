import { NO_USER_REASON, TARGET, USER_SOURCE } from '../support/env';
import { expect, test } from '../support/fixtures';

/**
 * Signing out revokes EVERY session of the account — SignOutButton calls
 * `supabase.auth.signOut()`, whose default scope is global. So this runs in its
 * own project, after the `signed-in` project has finished with the shared
 * session (playwright.config.ts), and never against production, where the same
 * test account may be signed in elsewhere.
 */
test.describe('signing out', () => {
  test.skip(!USER_SOURCE, NO_USER_REASON);
  test.skip(TARGET === 'production', 'signing out revokes every session of the shared test account');

  test('ends the session', { tag: '@sign-out' }, async ({ page }) => {
    await page.goto('/lore');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);

    await page.goto('/lore');
    await expect(page).toHaveURL((url) => url.pathname === '/login');
  });
});
