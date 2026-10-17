import { signInThroughTheForm } from '../support/auth';
import { HAS_AUTH_BACKEND } from '../support/env';
import { expect, test } from '../support/fixtures';

// The provider-choice screen and the email form are specs/journeys.md (Spec 3).
// This flow stays in TypeScript: the form's submit is named "Sign in" like the
// header's GitHub button, and the grammar cannot scope a locator to the form.
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
