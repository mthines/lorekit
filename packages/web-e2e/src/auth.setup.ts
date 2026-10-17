import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EMPTY_STORAGE_STATE, STORAGE_STATE, provisionUser, signInThroughTheForm } from './support/auth';
import { NO_USER_REASON, USER_SOURCE } from './support/env';
import { expect, test as setup } from './support/fixtures';

/**
 * Sign in once, through the real form, and save the session for the
 * `signed-in` project (playwright.config.ts). Every signed-in test reuses it.
 */
setup('sign in through the login form', async ({ page }) => {
  mkdirSync(path.dirname(STORAGE_STATE), { recursive: true });
  // Always leave a file behind: the `signed-in` project loads this path, and
  // its tests skip themselves when there is no user.
  writeFileSync(STORAGE_STATE, JSON.stringify(EMPTY_STORAGE_STATE));
  setup.skip(!USER_SOURCE, NO_USER_REASON);

  const user = USER_SOURCE!.kind === 'fixed' ? USER_SOURCE! : await provisionUser(USER_SOURCE!);
  await signInThroughTheForm(page, user.email, user.password);

  // Plain /login lands on DEFAULT_POST_LOGIN_PATH (lib/auth-redirect.ts).
  await expect(page).toHaveURL((url) => url.pathname === '/lore', { timeout: 30_000 });
  // An authenticated-only control, so a route that also renders signed out
  // can never be mistaken for a session.
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
