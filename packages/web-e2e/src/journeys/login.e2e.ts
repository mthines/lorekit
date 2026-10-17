import { signInThroughTheForm } from '../support/auth';
import { HAS_AUTH_BACKEND, TARGET } from '../support/env';
import { expect, test } from '../support/fixtures';

// The provider-choice screen and the email form are a spec in specs/journeys.md
// ("The login page offers GitHub, email and magic-link sign-in").
// This flow stays in TypeScript: the form's submit is named "Sign in" like the
// header's GitHub button, and the grammar cannot scope a locator to the form.
test.describe('signing in with a wrong password', () => {
  // The auth endpoint answers 400 for bad credentials; Chromium logs that
  // failed request as a console error.
  test.use({ allowedConsoleErrors: [/status of 400/, /auth\/v1\/token/] });

  test('shows an error and stays on /login', async ({ page }) => {
    test.skip(!HAS_AUTH_BACKEND, 'a local build with no Supabase behind it cannot answer a sign-in');
    // Never against production: one failed sign-in per deploy, from shared CI
    // runner IPs, is noise for the auth logs and a rate-limit flake away from
    // rolling back a healthy deploy. The PR job proves it against a local stack.
    test.skip(TARGET === 'production', 'a deliberately failed sign-in is not sent to production auth');
    await signInThroughTheForm(page, `nobody-${Date.now()}@lorekit.test`, 'definitely-not-the-password-1A!');
    await expect(page.locator('form').getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === '/login');
  });
});
