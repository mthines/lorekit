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

// ── lessons-pure.mjs stays dependency-free ───────────────────────────────────
// The module exists precisely so the SessionStart hot path can share the
// precedence, matching and ranking logic with the read commands WITHOUT
// dragging in the `lessons-view.mjs` render/`util`/lint/dedupe stack. Its
// zero-import property is the whole reason it is a separate file, and it is
// exactly the kind of invariant that erodes one convenient import at a time —
// each of which then loads on every single session start, and any of which
// could throw inside a hook contractually obliged to exit 0.
const LESSONS_PURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lessons-pure.mjs');

test('lessons-pure imports nothing — not a package, not even a node builtin', () => {
  const src = readFileSync(LESSONS_PURE, 'utf8');

  // Anti-vacuity: prove we are reading the real module before asserting on it.
  // Named per family so a rename cannot quietly make this guard pass on a stub.
  for (const fn of ['resolvePrecedence', 'matchesQuery', 'scopeIssue', 'rankLessons', 'scoreLesson']) {
    assert.match(src, new RegExp(`export function ${fn}\\b`), `lessons-pure.mjs is missing ${fn}() — guard would be vacuous`);
  }

  // Strip comments first: this module's header legitimately discusses imports
  // in prose, and so do comments trailing real code.
  //
  // Truncating at a `//` is a character scan rather than a regex because both
  // cheap approximations were wrong in opposite directions, and each one was
  // shipped and then caught: stripping only WHOLE-LINE comments let
  // `} // derived from the set` read as a re-export tail, while a regex
  // truncation is blind to quotes, so `const sep = '//'; require('node:fs');`
  // collapsed to `const sep = '` and hid a real dynamic dependency. Tracking
  // the quote state costs ten lines and is correct in both directions, which
  // also means one view of the source serves every assertion below.
  const stripLineComment = (line) => {
    let quote = null;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
  };

  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(stripLineComment)
    .join('\n');

  // A static dependency is not always `import`-prefixed. `export { x } from 'p'`
  // and `export * from 'p'` are RE-EXPORTS: they load the module on the hot
  // path exactly like an import does, and they slip past both the `import(`
  // and the `require(` checks below. A multi-line specifier list carries its
  // `from` on the closing line, so that shape is matched too.
  //
  // Both re-export arms require a QUOTED SPECIFIER after `from`, not the bare
  // word: a dependency always names a module, while prose and a parameter
  // called `from` (`export function f(a, from)`) do not. A guard that trips on
  // English is a guard the next person deletes.
  const statics = code.match(
    /^\s*(?:import\b[\s\S]*?$|export\b[^\n]*\bfrom\s*['"][^\n]*$|\}[^\n]*\bfrom\s*['"][^\n]*$)/gm,
  ) || [];
  assert.deepEqual(statics, [], 'lessons-pure.mjs must have no static imports or re-exports');

  // A dynamic `import(...)` or a `require(...)` would defeat the static check
  // while costing the same load on the hot path. Unlike the patterns above
  // these match ANYWHERE on a line, which is why the comment strip has to be
  // string-aware rather than merely conservative.
  assert.ok(!/\bimport\s*\(/.test(code), 'lessons-pure.mjs must not use a dynamic import()');
  assert.ok(!/\brequire\s*\(/.test(code), 'lessons-pure.mjs must not use require()');
});

// ── The SessionStart set is bounded by a budget, not by a magic count ─────────
// `MAX_LESSONS = 15` was a number with no derivation that acted as a floor as
// well as a ceiling — a six-lesson workspace and a six-hundred-lesson one both
// got fifteen. It is replaced by `hooks.sessionStart.maxChars`. This guard makes
// its return a visible edit rather than a quiet reintroduction.
const LESSONS_CORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'lessons.mjs');

test('no fixed lesson count cap survives in the SessionStart path', () => {
  const src = readFileSync(LESSONS_CORE, 'utf8');

  // Anti-vacuity: prove this is the module the guard means to read.
  assert.match(src, /export async function fetchLessons/, 'core/lessons.mjs did not parse');
  assert.match(src, /HARD_LESSON_CEILING/, 'the worst-case ceiling is missing');

  // Strip comments — the header legitimately NAMES the retired constant to
  // explain why it is gone.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');

  assert.ok(
    !/\bMAX_LESSONS\b/.test(code),
    'MAX_LESSONS is back — the injected set is budgeted by hooks.sessionStart.maxChars',
  );
});

// ── The mirrored route cap must track the schema it mirrors ──────────────────
// `MAX_STORE_LIST_LIMIT` in `core/lessons.mjs` is a self-contained copy of the
// `limit` ceiling `GET /memories` validates against — this package takes no
// dependencies, so it cannot import the schema and compare at runtime. That is
// the `limits.ts` mirroring pattern, and its standing risk is drift.
//
// Drift is not symmetrical here, which is why this guard reads the OTHER side
// rather than restating our own literal (a `MAX_STORE_LIST_LIMIT <= 100` check
// is tautological — it can only re-assert the number the constant declares two
// lines away). If the ROUTE lowers its cap and we do not, every per-scope read
// at a raised `maxLessons` becomes a 400; `fetchLessons` is best-effort, so it
// skips the scope and the SessionStart block silently empties — the exact bug
// this constant was introduced to fix. A test that cannot see the route's
// number cannot catch that.
const SCHEMAS_MEMORY = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas', 'src', 'memory.ts',
);

test('MAX_STORE_LIST_LIMIT matches the limit cap MemoryListSchema enforces', () => {
  const cliSrc = readFileSync(LESSONS_CORE, 'utf8');
  const schemaSrc = readFileSync(SCHEMAS_MEMORY, 'utf8');

  // Anti-vacuity on BOTH sides: a regex that quietly stops matching would make
  // this guard pass forever, which is the failure mode it exists to prevent.
  const mirrored = cliSrc.match(/MAX_STORE_LIST_LIMIT\s*=\s*(\d+)/);
  assert.ok(mirrored, 'MAX_STORE_LIST_LIMIT is gone from core/lessons.mjs');

  const route = schemaSrc.match(
    /MemoryListSchema[\s\S]*?limit:\s*z\.number\(\)\.int\(\)\.min\(1\)\.max\((\d+)\)/,
  );
  assert.ok(route, "MemoryListSchema's limit shape changed — re-derive this guard");

  assert.equal(
    Number(mirrored[1]),
    Number(route[1]),
    'the CLI mirrors a limit cap the route no longer enforces — an over-cap read '
      + '400s, and the best-effort hook turns that into a silently empty block',
  );
});
