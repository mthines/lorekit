import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './src/support/auth';
import { BASE_URL, E2E_PORT, STARTS_LOCAL_SERVER, TARGET } from './src/support/env';

const CI = Boolean(process.env.CI);

/**
 * Projects, in the order they run:
 *
 *   setup      signs in once through the login form and saves the session
 *              (skipped, with the reason, when no test user is configured).
 *   public     everything a signed-out visitor sees. Needs no credentials and
 *              no backend, so it runs on every PR against a local build.
 *   signed-in  tests tagged @signed-in, reusing the saved session.
 *   sign-out   tagged @sign-out; runs last because signing out revokes every
 *              session of the account, including the one `signed-in` uses.
 *
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` points Chromium at a browser you
 * already have (a sandbox that cannot reach Playwright's download host, for
 * example). Unset — the normal case, CI included — Playwright uses its own.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
const desktop = {
  ...devices['Desktop Chrome'],
  ...(executablePath ? { launchOptions: { executablePath } } : {}),
};

export default defineConfig({
  testDir: './src',
  // `*.e2e.ts` (and the setup project's `*.setup.ts`) are Playwright's;
  // `*.test.ts` is vitest's (the route coverage guard), so the two runners
  // never pick up each other's files.
  testMatch: /.*\.e2e\.ts$/,
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 2 : undefined,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  // otel-reporter ships each test as a trace to Dash0 (service.name=e2e) when a
  // telemetry credential is set (LOREKIT_TELEMETRY_TOKEN in CI) and is a no-op otherwise.
  reporter: CI
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['./src/support/otel-reporter.ts']]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['./src/support/otel-reporter.ts']],

  use: {
    baseURL: BASE_URL,
    // A trace stores request headers and cookies verbatim, and CI uploads it from a
    // public repo — so never record one where a production session is in play.
    // The PR job (local stack, throwaway user) keeps traces.
    trace: TARGET === 'production' ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Production builds register /sw.js, which serves pages cache-first; a
    // smoke test must see what the server returns now.
    serviceWorkers: 'block',
  },

  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts$/, use: desktop },
    { name: 'public', grepInvert: /@signed-in|@sign-out/, use: desktop },
    {
      name: 'signed-in',
      grep: /@signed-in/,
      dependencies: ['setup'],
      use: { ...desktop, storageState: STORAGE_STATE },
    },
    {
      name: 'sign-out',
      grep: /@sign-out/,
      dependencies: ['signed-in'],
      use: { ...desktop, storageState: STORAGE_STATE },
    },
  ],

  // No E2E_BASE_URL → serve a production build of packages/web locally. Build
  // it first with `pnpm nx run web-e2e:build-web` (NEXT_PUBLIC_* values are
  // inlined at build time, so the build — not this server — decides which
  // Supabase the site talks to). E2E_WEB_COMMAND swaps the command, e.g. for
  // `next dev` while iterating.
  webServer: STARTS_LOCAL_SERVER
    ? {
        command: process.env.E2E_WEB_COMMAND || `pnpm --filter @lorekit/web exec next start --port ${E2E_PORT}`,
        url: BASE_URL,
        reuseExistingServer: !CI,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          NEXT_PUBLIC_USE_LOCAL_SUPABASE: 'true',
          NEXT_TELEMETRY_DISABLED: '1',
        },
      }
    : undefined,
});
