import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { ProvisionedUser } from './env';

/** Where the setup project saves the signed-in session for the `signed-in` project. */
export const STORAGE_STATE = path.join(__dirname, '..', '..', '.auth', 'user.json');

/** A storage state with nothing in it — written when there is no user, so the path always exists. */
export const EMPTY_STORAGE_STATE = { cookies: [], origins: [] };

/**
 * Create a confirmed throwaway user on a LOCAL Supabase stack through the Auth
 * admin API. `env.ts` refuses a non-local URL before this is ever reached.
 * Nothing to clean up: the stack is torn down with the job.
 */
export async function provisionUser(source: ProvisionedUser): Promise<{ email: string; password: string }> {
  // Unique per run so concurrent runs never collide on the users_email_key.
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@lorekit.test`;
  const password = `E2e-${randomUUID()}-Aa1!`;
  const res = await fetch(`${source.supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: source.serviceRoleKey,
      Authorization: `Bearer ${source.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    // email_confirm skips the confirmation mail — the user can sign in at once.
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) {
    throw new Error(`could not provision a test user (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return { email, password };
}

/**
 * Sign in through the real login form — the path a person takes, not an API
 * shortcut, so a broken form fails here first.
 *
 * Keep in step with scripts/auth-bootstrap-credentials.mjs, which drives the
 * same form for aw-tester: the email form is hidden behind "Continue with
 * email", and two buttons read "Sign in" (the header's GitHub button and the
 * form submit), so the submit is scoped to the form.
 */
export async function signInThroughTheForm(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with email', exact: true }).click();
  await page.locator('#lk-email').fill(email);
  await page.locator('#lk-password').fill(password);
  await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
}
