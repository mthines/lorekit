#!/usr/bin/env node
// auth-inject-snippet.mjs — turn a captured Playwright storageState into a
// browser-injectable JS snippet, so the Chrome extension (claude-in-chrome) can
// reuse an aw-tester session WITHOUT ever touching the raw .env credentials.
//
// ── The two-step, zero-manual sign-in for the Chrome extension ───────────────
//   1. Capture a session from .env (headless, automated — no manual login):
//        node scripts/auth-bootstrap-credentials.mjs   (via the aw-target refresh)
//      → writes ./.auth/local.json
//   2. Inject that session into your REAL Chrome via the extension:
//        node scripts/auth-inject-snippet.mjs ./.auth/local.json
//      → prints a JS snippet. Navigate the extension tab to the target origin,
//        run the snippet with the `javascript_tool`, then reload. Done.
//
// Only the captured SESSION crosses into the extension — never the password or
// any other .env secret. The Supabase session cookie is a project-scoped JWT
// (project pqokxlhvnosogizsjztg), so ONE localhost capture authenticates the
// extension on localhost, a Vercel preview, OR lorekit.io — set the cookie on
// whatever origin the tab currently shows.
//
// httpOnly cookies CANNOT be set from page JS, so they are skipped (reported on
// stderr). None of LoreKit's httpOnly cookies are auth-critical.
//
// Usage:
//   node scripts/auth-inject-snippet.mjs [storageStateFile] [--with-localstorage] [--origin <origin>]
//     storageStateFile        default ./.auth/local.json
//     --with-localstorage      also restore localStorage for the chosen origin
//                              (telemetry/anon keys — not needed for auth)
//     --origin <origin>        which origins[] entry's localStorage to use
//                              (default: the file's first origin)
//
// The snippet is written to STDOUT (pipe/copy it into javascript_tool); a
// human-readable summary of what it will set goes to STDERR.

import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) ?? './.auth/local.json';
const withLocalStorage = args.includes('--with-localstorage');
const originIdx = args.indexOf('--origin');
const wantOrigin = originIdx !== -1 ? args[originIdx + 1] : null;

if (!fs.existsSync(file)) {
  console.error(`✗ storageState file not found: ${file}`);
  console.error('  Capture one first: run the aw-target refresh command (auth-bootstrap-credentials.mjs).');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const allCookies = state.cookies ?? [];
const settable = allCookies.filter((c) => !c.httpOnly);
const skipped = allCookies.filter((c) => c.httpOnly);

if (settable.length === 0) {
  console.error('✗ No non-httpOnly cookies in the file — nothing the extension can inject.');
  process.exit(2);
}

// Pick the origin whose localStorage we restore (opt-in).
let localStorageEntries = [];
let chosenOrigin = null;
if (withLocalStorage) {
  const origins = state.origins ?? [];
  const match = wantOrigin ? origins.find((o) => o.origin === wantOrigin) : origins[0];
  if (match) {
    chosenOrigin = match.origin;
    localStorageEntries = match.localStorage ?? [];
  }
}

// Only the fields the browser needs — keeps the embedded payload minimal.
const cookiePayload = settable.map((c) => ({
  name: c.name,
  value: c.value,
  path: c.path || '/',
  sameSite: c.sameSite || 'Lax',
  expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : null,
}));
const lsPayload = localStorageEntries.map((l) => ({ name: l.name, value: l.value }));

// The emitted snippet self-adjusts to the tab's protocol at run time, so the
// same output works on http://localhost and on the https preview/prod hosts.
const snippet = `(() => {
  const secure = location.protocol === 'https:';
  const cookies = ${JSON.stringify(cookiePayload)};
  for (const c of cookies) {
    let s = c.name + '=' + c.value + '; path=' + c.path + '; SameSite=' + c.sameSite;
    if (secure) s += '; Secure';
    s += c.expires ? '; expires=' + new Date(c.expires * 1000).toUTCString()
                   : '; max-age=31536000';
    document.cookie = s;
  }
  const ls = ${JSON.stringify(lsPayload)};
  for (const item of ls) { try { localStorage.setItem(item.name, item.value); } catch {} }
  return 'lorekit-auth: set ' + cookies.length + ' cookie(s)' +
         (ls.length ? ' + ' + ls.length + ' localStorage key(s)' : '') +
         ' — reload the page to apply.';
})();`;

// STDERR: summary only (no values).
console.error(`Session source: ${file}`);
console.error(`Cookies to set: ${settable.map((c) => c.name).join(', ')}`);
if (skipped.length) console.error(`Skipped (httpOnly, non-auth): ${skipped.map((c) => c.name).join(', ')}`);
if (withLocalStorage) {
  console.error(
    lsPayload.length
      ? `localStorage (${chosenOrigin}): ${lsPayload.map((l) => l.name).join(', ')}`
      : `localStorage: requested but no matching origin in the file`,
  );
}
console.error('Next: run the STDOUT snippet in the extension via javascript_tool on the target tab, then reload.');

// STDOUT: the snippet.
process.stdout.write(snippet + '\n');
