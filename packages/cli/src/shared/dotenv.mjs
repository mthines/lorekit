// LoreKit CLI — zero-dependency `.env` loader.
//
// The CLI is strictly zero-dependency (see package.json), and `engines.node`
// is `>=18`, so we can rely on neither the `dotenv` package nor Node's built-in
// `process.loadEnvFile()` (added in 20.6). This hand-rolled loader fills the gap
// with a small, faithful parser and a best-effort file read.
//
// Semantics (chosen to match the dominant `dotenv` mental model, NOT Node's
// `--env-file`):
//   • A `.env` in the current working directory is loaded automatically if it
//     exists. A missing file is a silent no-op — the default for real users.
//   • Existing real environment variables WIN. A value already present in
//     `process.env` (an explicit `export`, a CI var, an inline `FOO=bar cmd`)
//     is never overwritten by the file. So a committed `.env` is a fallback,
//     and a shell opt-out like `LOREKIT_TELEMETRY=0` can't be silently undone.
//   • Loading never throws — a malformed line is skipped, an unreadable file is
//     ignored. Nothing is printed, so machine-facing `hook` / `mcp` stdout is
//     never touched.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse the contents of a `.env` file into a flat key→value object. Pure and
 * unit-tested. Supports: blank lines, `#` comments, an optional `export `
 * prefix, single/double-quoted values (double quotes unescape \n \r \t \\ \"),
 * and trailing inline comments after unquoted values. Invalid keys are skipped.
 */
export function parseDotEnv(text) {
  const out = {};
  if (!text) return out;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Strip an optional `export ` prefix (a common shell-sourceable convention).
    const withoutExport = line.startsWith('export ') ? line.slice(7).trimStart() : line;

    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue; // no key, or `=value` with empty key → skip

    const key = withoutExport.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;

    out[key] = parseValue(withoutExport.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Resolve one raw right-hand-side into its final string value: unwrap matching
 * quotes (unescaping only inside double quotes), or, for a bare value, drop a
 * trailing ` # comment`.
 */
function parseValue(raw) {
  if (!raw) return '';
  const q = raw[0];
  if ((q === '"' || q === "'") && raw.length >= 2 && raw[raw.length - 1] === q) {
    const inner = raw.slice(1, -1);
    return q === '"'
      ? inner.replace(/\\([nrt"\\])/g, (_, ch) =>
          ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch,
        )
      : inner;
  }
  // Unquoted: a whitespace-preceded `#` starts an inline comment.
  const hash = raw.search(/\s#/);
  return (hash === -1 ? raw : raw.slice(0, hash)).trim();
}

/**
 * Load a `.env` from `cwd` into `env`, without overriding keys already set.
 * Best-effort: returns the list of keys it applied (empty if the file is absent
 * or unreadable). Never throws, never prints.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]  directory to look for `.env` in (default cwd)
 * @param {object} [opts.env]  target env object to mutate (default process.env)
 * @returns {string[]} keys newly set from the file
 */
export function loadDotEnv({ cwd = process.cwd(), env = process.env } = {}) {
  let text;
  try {
    text = readFileSync(path.join(cwd, '.env'), 'utf8');
  } catch {
    return []; // no file (ENOENT) or unreadable → nothing to do
  }

  const applied = [];
  try {
    const parsed = parseDotEnv(text);
    for (const [key, value] of Object.entries(parsed)) {
      // Real env wins: only fill keys that aren't already set.
      if (env[key] === undefined) {
        env[key] = value;
        applied.push(key);
      }
    }
  } catch {
    // A malformed file must never break the CLI — leave whatever was applied.
  }
  return applied;
}
