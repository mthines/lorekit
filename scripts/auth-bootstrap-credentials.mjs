#!/usr/bin/env node
// auth-bootstrap-credentials.mjs — automated headless login capture for aw-tester.
//
// Logs in headlessly with the LoreKit test user's email + password (from env
// vars) and captures the resulting Supabase session as a Playwright storage
// state. Use this flow for unattended re-auth (CI, Claude Web, mass test runs).
//
// LoreKit specifics baked into the locator ladder below:
//   - The login page (/login) opens on a provider CHOICE screen. The email +
//     password fields are NOT visible until you click "Continue with email".
//   - The email field is #lk-email, the password field is #lk-password.
//   - Two buttons on the page read "Sign in" (the nav GitHub button and the
//     form submit), so we submit by pressing Enter on the password field
//     rather than clicking an ambiguous role locator.
//
// >>> If the login form changes, edit the CUSTOMIZE block below. <<<
// Prefer accessibility-tree locators (getByRole / getByLabel) and the stable
// #lk-* ids over CSS classes — they survive design changes.
//
// Environment variables:
//   AUTH_LOGIN_URL              — required; the page that hosts the login form
//   AUTH_STORAGE_STATE          — required; output path (typically ./.auth/<name>.json)
//   AUTH_POST_LOGIN_URL_PATTERN — required; JS regex source matched against the
//                                 page URL after submit (e.g. '/overview')
//   LOREKIT_TESTING_USER_NAME   — required; the test user's email (username == email)
//   LOREKIT_TESTING_USER_PW     — required; the test user's password
//                                 (from .env.local locally, or the shell on
//                                 Claude Web — NEVER commit this value)
//   AUTH_TIMEOUT_MS             — optional; max wait for the post-login URL
//                                 (default: 30000)
//   AUTH_PROXY_SERVER / HTTPS_PROXY — optional; proxy for headless Chromium.
//                                 Needed in a sandbox (e.g. Claude Web) whose
//                                 egress is proxied — Chromium ignores the env
//                                 proxy unless it is passed explicitly.
//
// Example (the aw-target refresh.command sources .env.local first):
//   AUTH_LOGIN_URL=http://localhost:3000/login \
//     AUTH_STORAGE_STATE=./.auth/local.json \
//     AUTH_POST_LOGIN_URL_PATTERN='/overview' \
//     node scripts/auth-bootstrap-credentials.mjs

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';

// A sandbox (e.g. the Claude Web environment) routes egress through a proxy.
// Chromium does NOT read HTTPS_PROXY on its own, so without this it can't reach
// the login host and the run fails with an opaque net error. Pass the env proxy
// explicitly. Unset locally → returns undefined → identical to the old behaviour.
function proxyFromEnv() {
  const url =
    process.env.AUTH_PROXY_SERVER ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY;
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const proxy = { server: `${u.protocol}//${u.host}` };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch {
    return { server: url };
  }
}

// Launch headless Chromium, wiring the env proxy when present. A fresh sandbox
// often has no browser binary yet, so on that specific failure do a best-effort
// `playwright install chromium` and retry once (the download may itself be
// egress-blocked — if so we rethrow the original launch error).
async function launchBrowser() {
  const proxy = proxyFromEnv();
  const opts = { headless: true, ...(proxy ? { proxy } : {}) };
  try {
    return await chromium.launch(opts);
  } catch (err) {
    if (/Executable doesn.?t exist|playwright install/i.test(err.message)) {
      console.error('Chromium binary missing; running `playwright install chromium`...');
      try {
        execSync('pnpm exec playwright install chromium', { stdio: 'inherit' });
      } catch {
        /* egress may block cdn.playwright.dev — fall through to retry, which rethrows */
      }
      return await chromium.launch(opts);
    }
    throw err;
  }
}

const LOGIN_URL = process.env.AUTH_LOGIN_URL;
const OUTPUT = process.env.AUTH_STORAGE_STATE;
const POST_LOGIN_PATTERN = process.env.AUTH_POST_LOGIN_URL_PATTERN;
const EMAIL = process.env.LOREKIT_TESTING_USER_NAME;
const PASSWORD = process.env.LOREKIT_TESTING_USER_PW;
const TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_MS ?? 30_000);

const missing = [];
if (!LOGIN_URL) missing.push('AUTH_LOGIN_URL');
if (!OUTPUT) missing.push('AUTH_STORAGE_STATE');
if (!POST_LOGIN_PATTERN) missing.push('AUTH_POST_LOGIN_URL_PATTERN');
if (!EMAIL) missing.push('LOREKIT_TESTING_USER_NAME');
if (!PASSWORD) missing.push('LOREKIT_TESTING_USER_PW');
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  console.error('See the header comment of this file for the full list.');
  console.error('Locally these live in .env.local; on Claude Web they are in the shell.');
  process.exit(1);
}

await mkdir(path.dirname(OUTPUT), { recursive: true });

const browser = await launchBrowser();
const context = await browser.newContext();
const page = await context.newPage();

try {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  // >>> CUSTOMIZE START <<<
  // 1. Reveal the email + password form (idle screen shows provider choices).
  await page.getByRole('button', { name: /continue with email/i }).click();
  // 2. Fill the credentials. #lk-email / #lk-password are stable ids.
  await page.locator('#lk-email').fill(EMAIL);
  await page.locator('#lk-password').fill(PASSWORD);
  // 3. Submit. Two buttons read "Sign in", so press Enter on the password
  //    field instead of clicking an ambiguous role locator.
  await page.locator('#lk-password').press('Enter');
  // >>> CUSTOMIZE END <<<

  await page.waitForURL(new RegExp(POST_LOGIN_PATTERN), { timeout: TIMEOUT_MS });
  await context.storageState({ path: OUTPUT });
  console.error(`✓ Saved storage state to ${OUTPUT}`);
  process.exitCode = 0;
} catch (err) {
  console.error(`✗ Login failed: ${err.message}`);
  console.error('Check the CUSTOMIZE block in this script, the credentials, and the post-login URL pattern.');
  process.exitCode = 2;
} finally {
  await browser.close();
}
