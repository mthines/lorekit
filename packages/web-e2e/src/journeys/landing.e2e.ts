import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';

/**
 * The landing header's links. TypeScript, not a spec: the footer repeats
 * "Docs" and "Blog", and the spec grammar cannot scope a locator to the
 * header nav.
 */
const site = (page: Page) => page.getByRole('navigation', { name: 'Site' });

test('the landing page header leads to the docs', async ({ page }) => {
  await page.goto('/');
  await site(page).getByRole('link', { name: 'Docs', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/docs/setup');
  await expect(page.getByRole('heading', { level: 1, name: 'Getting started', exact: true })).toBeVisible();
});

test('the landing page header leads to the blog', async ({ page }) => {
  await page.goto('/');
  await site(page).getByRole('link', { name: 'Blog', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/blog');
  await expect(page.getByRole('heading', { level: 1, name: 'Blog', exact: true })).toBeVisible();
});
