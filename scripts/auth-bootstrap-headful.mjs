#!/usr/bin/env node
// auth-bootstrap-headful.mjs — interactive headful login capture for aw-tester.
//
// Opens a headful Chromium, navigates to the login URL, and waits for you to
// finish logging in. When (a) the page reaches AUTH_POST_LOGIN_URL_PATTERN
// (if set) OR (b) you close the browser window, the script captures the
// authenticated storage state and writes it to AUTH_STORAGE_STATE.
//
// Use this flow when:
//   - SSO, OAuth, or a passwordless flow makes scripted login painful
//   - You only need to refresh auth occasionally (storage state lasts days/weeks)
//   - You want a visible, audited "I logged in as this user" step
//
// Environment variables (all read once, no live re-resolution):
//   AUTH_LOGIN_URL              — required; the URL to open in the browser
//   AUTH_STORAGE_STATE          — required; output path (typically ./.auth/<name>.json)
//   AUTH_POST_LOGIN_URL_PATTERN — optional; JS regex source — when the page URL
//                                 matches, auto-save and close (avoids the user
//                                 having to close the browser manually)
//
// Examples:
//   AUTH_LOGIN_URL=http://localhost:3000/login \
//     AUTH_STORAGE_STATE=./.auth/local.json \
//     AUTH_POST_LOGIN_URL_PATTERN='/dashboard' \
//     node scripts/auth-bootstrap-headful.mjs
//
//   # In aw-target.yml:
//   #   auth.refresh.command: AUTH_LOGIN_URL=http://localhost:3000/login \
//   #     AUTH_STORAGE_STATE=./.auth/local.json node scripts/auth-bootstrap-headful.mjs

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const LOGIN_URL = process.env.AUTH_LOGIN_URL;
const OUTPUT = process.env.AUTH_STORAGE_STATE;
const POST_LOGIN_PATTERN = process.env.AUTH_POST_LOGIN_URL_PATTERN;
const MAX_WAIT_MS = Number(process.env.AUTH_TIMEOUT_MS ?? 10 * 60 * 1000); // 10 min default

if (!LOGIN_URL || !OUTPUT) {
  console.error('AUTH_LOGIN_URL and AUTH_STORAGE_STATE must be set.');
  console.error('See https://playwright.dev/docs/auth#reuse-signed-in-state for background.');
  process.exit(1);
}

await mkdir(path.dirname(OUTPUT), { recursive: true });

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

let saved = false;
async function save(reason) {
  if (saved) return;
  saved = true;
  try {
    await context.storageState({ path: OUTPUT });
    console.error(`✓ Saved storage state to ${OUTPUT} (trigger: ${reason}).`);
  } catch (err) {
    console.error(`✗ Could not save storage state: ${err.message}`);
    process.exitCode = 2;
  }
}

// Always try to save when the browser disconnects (user closed the window).
browser.on('disconnected', () => save('browser closed'));

await page.goto(LOGIN_URL);
console.error(`Opened ${LOGIN_URL} in a headful browser.`);
if (POST_LOGIN_PATTERN) {
  console.error(`Will auto-save when the URL matches /${POST_LOGIN_PATTERN}/.`);
  console.error(`(Or close the browser manually; storage state saves on close.)`);
} else {
  console.error(`Log in, then close the browser window. Storage state will save on close.`);
}

if (POST_LOGIN_PATTERN) {
  try {
    await page.waitForURL(new RegExp(POST_LOGIN_PATTERN), { timeout: MAX_WAIT_MS });
    await save('post-login URL matched');
    await browser.close();
    process.exit(0);
  } catch (err) {
    // Timed out waiting for the pattern — fall through to the disconnect handler.
    console.error(`Did not see the post-login URL within ${MAX_WAIT_MS}ms; waiting for manual close.`);
  }
}

// Block until the browser actually closes; the disconnect handler does the save.
await new Promise((resolve) => browser.once('disconnected', resolve));
process.exit(saved ? 0 : 3);
