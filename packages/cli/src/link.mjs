// `lorekit link` (alias `url`) — print a shareable dashboard deep-link URL to
// stdout for the current directory's context, a scope, or a specific lesson.
//
// Read-only and network-free: it derives scopes from git and builds a URL — it
// never talks to a store. The URL alone is written to stdout (pipeable, e.g.
// `lorekit link | pbcopy`); any advisory note goes to stderr, and only when
// stderr is a TTY, so a pipe stays clean. Human-facing, so the bin wraps it in
// `traceCommand`.
//
//   lorekit link                    → /lore filtered to the cwd's most-specific scope
//   lorekit link <scope>            → /lore?scope="<scope>"
//   lorekit link <scope> <key>      → a link that opens that lesson's detail sheet
//   lorekit link <scope::key>       → same, via the copy-paste shorthand
//
// Every param is JSON-encoded per the `useUrlState` contract (see
// `deeplink-pure.mjs`) — a raw `?scope=global` would silently mean "all scopes".
import process from 'node:process';
import { resolveProjectRoot } from './config.mjs';
import { deriveScope } from './scope.mjs';
import { scopeIssue } from './lessons-view.mjs';
import {
  resolveAppBase,
  buildLoreUrl,
  mostSpecificScope,
  parseOwnerArg,
  parseViewArg,
  parseRangeArg,
  parseTagsArg,
  resolveScopeArg,
  surfaceFor,
} from './deeplink-pure.mjs';
import { log, err } from './util.mjs';

export async function link(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };
  const scopeInfo = deriveScope(root);
  const base = resolveAppBase({ base: args.base, env });

  // Positionals: link [scope] [key] OR link <scope::key>. args._[0] is the
  // command token ('link' / 'url'), so the first argument is args._[1].
  const first = typeof args._[1] === 'string' ? args._[1] : '';
  const second = typeof args._[2] === 'string' ? args._[2] : '';
  let scope = null;
  let key = null;
  if (first && second) {
    // Two positionals — the first IS the scope (even one containing `::`, like
    // `repo::owner/name`); the second is the key. The `scope::key` shorthand is
    // only consulted for a single positional, below.
    scope = first;
    key = second;
  } else if (first) {
    // One positional: disambiguate a bare scope from the `<scope>::<key>`
    // shorthand by scope validity, not by a naive first-`::` split — otherwise
    // `link repo::owner/name` (a valid scope) is misread as scope="repo" + a
    // bogus key. `scopeIssue(s) === null` is the canonical "is a valid scope".
    const resolved = resolveScopeArg(first, (s) => scopeIssue(s) === null);
    scope = resolved.scope;
    key = resolved.key;
  }
  // `--scope` sets the scope when no positional scope was given (consistency
  // with the other read commands); an explicit positional always wins.
  if (!scope && typeof args.scope === 'string' && args.scope) scope = args.scope;

  // Filter flags (all optional; each JSON-encoded + default-omitted downstream).
  const q = typeof args.q === 'string' ? args.q : '';
  const owner = parseOwnerArg(args.owner);
  const view = parseViewArg(args.view);
  const range = parseRangeArg(args);
  const tags = parseTagsArg(args.tags);
  const archived = Boolean(args.archived);

  const gaveAnyInput =
    Boolean(first) ||
    (typeof args.scope === 'string' && Boolean(args.scope)) ||
    Boolean(q) ||
    owner !== 'all' ||
    view !== 'scope' ||
    range !== null ||
    tags.length > 0 ||
    archived;

  // Bare `lorekit link` (no scope, no lesson, no filters) → the cwd's
  // most-specific scope, so it links to "what I'm looking at". Falls back to a
  // bare /lore when only `global` applies.
  if (!scope && !key && !gaveAnyInput) {
    scope = mostSpecificScope(scopeInfo);
  }

  // Assemble only the non-default params (clean URL + a truthful `--json`).
  const params = {};
  if (scope) params.scope = scope;
  if (key) params.lesson = { scope, key };
  if (q) params.q = q;
  if (owner !== 'all') params.owner = owner;
  if (tags.length) params.tags = tags;
  if (view !== 'scope') params.view = view;
  if (range !== null) params.range = range;
  if (archived) params.archived = true;

  // UX guard: a lesson/scope link pointing at a scope the caller isn't in
  // (a different repo/project) may render empty for them. Note it on stderr —
  // never stdout (keeps the URL pipeable) — and only when stderr is a TTY and
  // we're not emitting JSON, so scripts and pipes stay quiet.
  maybeWarnScope(scope, scopeInfo, args.json);

  return emitLink({ params, base, json: args.json });
}

// Emit a deep link: the URL alone on stdout (pipeable), or the structured
// `{ url, surface, base, params }` under `--json`. Returns the bounded, non-PII
// telemetry extras (the surface enum + booleans — never a scope string, key,
// query, or base URL). Shared by the `link` command AND the read commands'
// `--link` short-circuit so the two emit an identical shape. `params` is the
// already-assembled non-default param set.
export function emitLink({ params = {}, base, json }) {
  const url = buildLoreUrl(params, { base });
  const surface = surfaceFor(params);
  if (json) {
    log(JSON.stringify({ url, surface, base, params }, null, 2));
  } else {
    log(url);
  }
  return {
    exitCode: 0,
    'lorekit.cli.link.surface': surface,
    'lorekit.cli.link.has_scope': Boolean(params.scope),
    'lorekit.cli.link.has_lesson': Boolean(params.lesson),
  };
}

// Warn (stderr, TTY-only) when `scope` is a concrete scope the caller isn't in.
// `global` is always visible; a scope present in the cwd's `readOrder` is too.
function maybeWarnScope(scope, scopeInfo, json) {
  if (json || !scope || scope === 'global') return;
  if (!process.stderr.isTTY) return;
  if ((scopeInfo.readOrder || []).includes(scope)) return;
  err(
    `note: ${scope} is not one of your current scopes ` +
      `(${(scopeInfo.readOrder || []).join(', ')}); ` +
      `the link may show nothing if you can't access that scope.`,
  );
}
