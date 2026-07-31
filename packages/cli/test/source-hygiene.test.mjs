// Source hygiene: no source file may contain a raw NUL byte. A stray NUL makes
// git classify the file as *binary* — its diffs then render as "Binary files
// differ", silently hiding every future change to it from review. Use the
// 4-character escape `\x00` in a string literal instead (it parses to the same
// NUL char). This guards the whole `src/` tree, not just the one file that
// regressed once (`lessons-view.mjs`'s tag-set separator in `recordsDiverge`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Every file under src/ (any extension) — a raw NUL makes git treat ANY file
// as binary, not just .mjs, so the guard scans the whole tree rather than one
// extension. src/ is source-only today; if a genuine binary asset is ever
// added here, narrow this walker at that point.
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else out.push(full);
  }
  return out;
}

test('no source file contains a raw NUL byte (would make git treat it as binary)', () => {
  const offenders = [];
  for (const file of sourceFiles(srcDir)) {
    const buf = readFileSync(file);
    if (buf.includes(0)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `raw NUL byte(s) found — use the "\\x00" escape instead:\n${offenders.join('\n')}`,
  );
});

// ── The remote store speaks REST, and only REST ───────────────────────────────
// `packages/cli/src/store/remote.mjs` used to hold an MCP JSON-RPC transport
// open purely for the four `org.*` ops and a `ping` fallback. Those are REST
// routes now (`supabase/functions/orgs/`, which serves `lk_*` tokens as of
// migration 00041). Nothing in the store may reach for JSON-RPC again: a
// re-added `mcpCall` would keep working against a live backend while silently
// bypassing `restFetch`'s error shape and the REST route-parity guard.
//
// `src/mcp.mjs` itself is NOT dead — it backs the `lorekit mcp` stdio server
// command and exports `mcpToRestBase`/`restFetch`. Only the store is guarded.
const REMOTE_STORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'store', 'remote.mjs');

test('the remote store contains no MCP transport call', () => {
  const src = readFileSync(REMOTE_STORE, 'utf8');

  // Anti-vacuity: prove we are reading the real file, not an empty/renamed one.
  assert.match(src, /class RemoteStore/, 'remote.mjs did not parse as the remote store');
  for (const method of ['orgCreate', 'orgList', 'orgRename', 'orgDelete', 'ping']) {
    assert.ok(src.includes(`async ${method}(`), `remote.mjs is missing ${method}() — guard would be vacuous`);
  }

  // Strip comments: the header legitimately NAMES mcpCall to explain its absence.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');

  for (const banned of ['mcpCall', '_mcp(', '_mcpEntries']) {
    assert.ok(
      !code.includes(banned),
      `remote.mjs references "${banned}" — the store must issue REST calls only (see supabase/functions/orgs/)`,
    );
  }
});
