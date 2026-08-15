// The control model: decide the memory mode (off | local | remote), the store
// target, who decided, and which deny constraints are active. Also resolves
// write-behaviour properties from the config layers:
//
//   scope.defaults  — map of scope-prefix → { tags, ttl_days } applied to every
//                     matching write
//   tags.default    — array of tags appended to every write (both layers merged)
//   ttl.default     — days until a write with no explicit TTL expires
//   hooks.disabled  — array of hook event names to suppress (e.g. ["Stop"])
//   hooks.stop      — Stop-hook gating ("friction" default | "always" | "off")
//   hooks.sessionStart          — injected-block shape ("hybrid" default | "index" | "map")
//   hooks.sessionStart.maxChars — character budget for that block (default 1500)
//   hooks.sessionStart.loopCap  — max lessons per self-improvement loop bucket (default 2; 0 excludes them)
//   hooks.sessionStart.maxLessons — max LINES that block may hold (default 40, range 3–200)
//   hooks.sessionStart.branchHint — nudge the read toward the git branch topic ("on" default | "off")
//   hooks.userPrompt — the per-turn relevance pull ("on" default | "off")
//   hooks.adapter   — explicit adapter override ("claude" | "cursor" | "codex")
//
// Two layers of config, two kinds of statement:
//   - a SELECT (`mode`) chooses a mode within what is allowed;
//   - a DENY forbids a mode outright and can never be overridden.
//
// Deny always wins. Denies are a UNION across every source and only ever
// accumulate — so a user-level "never remote" (privacy/compliance) is a ceiling
// no repo config or default can lift, and "never local" (no `.lorekit/` in the
// tree / CI) is enforceable the same way. `off` is always allowed (you cannot
// deny "disabled"), so it is the terminal fallback.
//
// Local mode is two-tier (mirroring the persistent-memory home + project-shared
// model): a per-user `home` tier at $LOREKIT_HOME (default `~/.lorekit/`) and an
// opt-in per-repo `project` tier at `<repo>/.lorekit/` (overridable with
// $LOREKIT_STORE). The resolved local `storeTarget` is `{ home, project }`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectConnection } from './config.mjs';
import { splitEndpoint } from './mcp.mjs';

export const MODES = ['off', 'local', 'remote'];

// Accept a few friendly spellings, incl. persistent-memory's `backend` values.
export function normalizeMode(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (['off', 'disabled', 'none', 'false'].includes(s)) return 'off';
  if (['local', 'markdown', 'file', 'files'].includes(s)) return 'local';
  if (['remote', 'lorekit', 'mcp', 'hosted'].includes(s)) return 'remote';
  return null;
}

// Stop-hook behaviour: `friction` (default — only nudge on detected friction),
// `always` (nudge once per session regardless), or `off` (never). Accepts a few
// friendly spellings so config stays forgiving.
export const STOP_MODES = ['friction', 'always', 'off'];
export function normalizeStopMode(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (['off', 'none', 'false', 'disabled', 'never'].includes(s)) return 'off';
  if (['always', 'all', 'on', 'true', 'every'].includes(s)) return 'always';
  if (['friction', 'smart', 'auto'].includes(s)) return 'friction';
  return null;
}

// `hooks.userPrompt` — the per-turn relevance pull, on or off.
//
// A BOOLEAN, not a mode, and that is a deliberate limit on the surface. The
// interesting knobs a mode would expose (how many lessons, how strict the
// match) are the two things this hook must never let a user turn up: it fires
// on EVERY prompt, so a generous setting is not a preference, it is a way to
// make the assistant unusable. The gates are fixed in code and reviewed here.
//
// Same forgiving vocabulary as `hooks.stop`, so a config that says `false`,
// `none` or `disabled` means what it looks like.
export const USER_PROMPT_MODES = ['on', 'off'];
export function normalizeUserPromptMode(v) {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (['off', 'none', 'false', 'disabled', 'never', 'no'].includes(s)) return 'off';
  if (['on', 'true', 'enabled', 'always', 'yes'].includes(s)) return 'on';
  return null;
}

// SessionStart shape: what the injected block LOOKS like once the budget is
// spent. All three spend the same character budget; they differ in what they do
// with the lessons that did not fit.
//   hybrid (default) — top-ranked lessons, then a one-line scope map naming what
//                      was left out, so nothing is silently invisible.
//   index            — lessons only. The pre-budget behaviour, minus the magic
//                      count: a big store is simply truncated with no map.
//   map              — the scope map plus a handful of the most salient lessons.
//                      For a large store where the inventory matters more than
//                      any particular lesson.
// Friendly spellings for the same reason `normalizeStopMode` has them: these are
// hand-edited JSON files.
export const SESSION_START_MODES = ['hybrid', 'index', 'map'];
export function normalizeSessionStartMode(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (['hybrid', 'both', 'auto', 'default'].includes(s)) return 'hybrid';
  if (['index', 'list', 'lessons', 'full'].includes(s)) return 'index';
  if (['map', 'scopes', 'summary', 'toc'].includes(s)) return 'map';
  return null;
}

// The default SessionStart character budget, and the bounds a configured one is
// held to. ~1500 chars is roughly 375 tokens on the 4-chars-per-token heuristic
// — enough for a dozen index lines plus the frame, and small enough that it
// stays a footnote in a context window rather than a section of it.
//
// The floor is what one header plus one lesson line needs; below it the block
// would be a header and nothing else, which is worse than not firing. The
// ceiling is a backstop against a typo'd `"maxChars": 1500000` turning every
// session start into a wall of text — the hard lesson ceiling in
// `core/lessons.mjs` bounds it a second time, from the other direction.
export const DEFAULT_SESSION_START_MAX_CHARS = 1500;
export const MIN_SESSION_START_MAX_CHARS = 200;
export const MAX_SESSION_START_MAX_CHARS = 20000;

// The events `hooks.instructions` can carry text for — every lifecycle event
// that emits something a project instruction could ride along with. Exported so
// `doctor` reports the same set the resolver reads: they were separate literals
// and drifted, which is how `UserPromptSubmit` ended up documented, accepted in
// config, and silently dropped by both.
export const HOOK_INSTRUCTION_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUseFailure',
  'Stop',
];

// Clamp a configured budget into the supported range, or null when the value is
// not a usable number at all (absent, a bare string, NaN). Total: the caller
// substitutes the default for null. Out-of-range CLAMPS rather than rejecting —
// a user who wrote `"maxChars": 50` wants a small block, and honouring the floor
// is closer to that intent than silently restoring the 1500 default.
export function normalizeSessionStartMaxChars(v) {
  const n = firstNumber(v);
  if (n === null) return null;
  const i = Math.round(n);
  if (i < MIN_SESSION_START_MAX_CHARS) return MIN_SESSION_START_MAX_CHARS;
  if (i > MAX_SESSION_START_MAX_CHARS) return MAX_SESSION_START_MAX_CHARS;
  return i;
}

// The default per-loop-bucket cap for the SessionStart read, and the bounds a
// configured one is held to. 2 keeps each self-improvement loop's top couple of
// lessons without letting one bucket flood a general session; 0 is a meaningful
// setting — exclude loop buckets entirely and read only general codebase lessons.
// The ceiling is a generous backstop against a typo'd cap, not a shared constant:
// `core/lessons.mjs` bounds the whole read at its own hard lesson ceiling
// downstream, so any loopCap at or above that never binds regardless of the exact
// number here — they are deliberately independent, not kept in lockstep.
export const DEFAULT_SESSION_START_LOOP_CAP = 2;
export const MIN_SESSION_START_LOOP_CAP = 0;
export const MAX_SESSION_START_LOOP_CAP = 40;

// Clamp a configured loop cap into range, or null when it is not a usable number
// (absent, a bare string, NaN). Total: the caller substitutes the default for
// null. Out-of-range CLAMPS rather than rejecting, like the maxChars budget — and
// `0` is honoured, not floored away, because "exclude loop buckets" is a real ask.
export function normalizeSessionStartLoopCap(v) {
  const n = firstNumber(v);
  if (n === null) return null;
  const i = Math.round(n);
  if (i < MIN_SESSION_START_LOOP_CAP) return MIN_SESSION_START_LOOP_CAP;
  if (i > MAX_SESSION_START_LOOP_CAP) return MAX_SESSION_START_LOOP_CAP;
  return i;
}

// The default SessionStart LINE ceiling, and the bounds a configured one is held
// to. 40 is exactly the hard ceiling `core/lessons.mjs` has always applied, so an
// unconfigured workspace gets byte-for-byte the block it got before this key
// existed.
//
// TWO BOUNDS, TWO QUESTIONS. `maxChars` bounds what the block COSTS; this bounds
// what it LOOKS LIKE. A budget alone cannot stop a store of 500 one-word keys
// from rendering 400 lines inside it, and a 400-line index is unreadable however
// few characters it costs. Whichever binds first wins, so raising this alone
// changes nothing on a store whose lines are long — `maxChars` has to come up
// with it.
//
// The floor is three: below that the block stops being an index and becomes a
// sample, and the `map` shape already shows three. The ceiling is a backstop
// against a typo'd `"maxLessons": 4000` — `core/lessons.mjs` clamps to the same
// number a second time, from the other direction, so a caller passing the option
// directly is bounded too.
//
// KEPT SMALL ON PURPOSE. The injected set is meant to be a working set, with
// `memory.search` for the tail; this is an opt-in dial for a reader who wants a
// wider index, not an invitation to raise the default.
export const DEFAULT_SESSION_START_MAX_LESSONS = 40;
export const MIN_SESSION_START_MAX_LESSONS = 3;
export const MAX_SESSION_START_MAX_LESSONS = 200;

// Clamp a configured line ceiling into range, or null when it is not a usable
// number (absent, a bare string, NaN). Total: the caller substitutes the default
// for null. Out-of-range CLAMPS rather than rejecting, exactly like the maxChars
// budget and the loop cap — a user who wrote `"maxLessons": 1` wants a short
// block, and honouring the floor is closer to that intent than silently
// restoring the 40 default.
export function normalizeSessionStartMaxLessons(v) {
  const n = firstNumber(v);
  if (n === null) return null;
  const i = Math.round(n);
  if (i < MIN_SESSION_START_MAX_LESSONS) return MIN_SESSION_START_MAX_LESSONS;
  if (i > MAX_SESSION_START_MAX_LESSONS) return MAX_SESSION_START_MAX_LESSONS;
  return i;
}

// A config value that is meant to be a number, or null when it is absent or is
// something else entirely. Numeric strings are accepted because JSON configs get
// hand-edited; the RANGE check happens later, at the point of use.
function firstNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Whether a config layer DECLARED a scalar policy value — the layer-selection
// predicate for keys that cannot merge. Same shape as the `hooks.adapter` guard
// below: a layer that put something usable-looking there owns the decision, even
// when the something turns out to be unparseable. Selecting the layer on the
// PARSED value instead is the bug: `firstNumber(repo) ?? firstNumber(user)` makes
// a garbage repo value (`"ttl.default": "90 days"`) indistinguishable from an
// absent one, so the user layer silently takes over and the retention a write
// gets depends on state outside the repository — two developers on the same
// commit would disagree, and neither could tell from the checkout.
function declaresScalar(v) {
  return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '');
}

function asList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

// Pure resolver — no IO. Given the already-loaded config objects, decide.
// Returns { mode, storeTarget, decidedBy, denies, connection }.
export function resolveControl({
  env = {},
  userConfig = {},
  repoConfig = {},
  connection = {},
  root = process.cwd(),
  home = env.LOREKIT_HOME || null,
} = {}) {
  // 1. Denies — union, deny-wins, accumulate (never removable).
  const denies = [];
  const addDeny = (mode, source) => {
    const m = normalizeMode(mode);
    if ((m === 'remote' || m === 'local') && !denies.some((d) => d.mode === m)) {
      denies.push({ mode: m, source });
    }
  };
  for (const m of asList(env.LOREKIT_DENY)) addDeny(m, 'env LOREKIT_DENY');
  for (const m of asList(userConfig.deny)) addDeny(m, 'user config (~/.lorekit/config.json)');
  for (const m of asList(repoConfig.deny)) addDeny(m, 'repo (.lorekit.json)');
  const denied = new Set(denies.map((d) => d.mode));

  // 2. Candidate selections, highest precedence first. An explicit env/flag
  //    outranks a user preference, which outranks the repo default, which
  //    outranks the built-in default.
  const candidates = [];
  const push = (mode, source) => {
    const m = normalizeMode(mode);
    if (m) candidates.push({ mode: m, source });
  };
  push(env.LOREKIT_MODE, 'env LOREKIT_MODE');
  push(userConfig.mode ?? userConfig.backend, 'user config (~/.lorekit/config.json)');
  push(repoConfig.mode ?? repoConfig.backend, 'repo (.lorekit.json)');
  // Built-in default is `remote`: it preserves the pre-control behaviour where
  // reads stay silent until a connection is configured while the retrospective
  // / failure nudges still fire (they are backend-agnostic reminders). `off`
  // is reached only by an explicit selection, or when `remote` is denied.
  push(
    'remote',
    connection.usable
      ? 'default (remote connection configured)'
      : 'default (remote — not yet configured)',
  );
  push('off', 'terminal fallback (all selections denied)');

  // 3. First candidate that is allowed. `off` is never denied, so this always
  //    resolves. A denied higher-precedence selection is silently capped.
  const idx = candidates.findIndex((c) => c.mode === 'off' || !denied.has(c.mode));
  const chosen = candidates[idx];
  const cappedModes = [
    ...new Set(candidates.slice(0, idx).filter((c) => denied.has(c.mode)).map((c) => c.mode)),
  ];
  const decidedBy = cappedModes.length
    ? `${chosen.source} (after deny: ${cappedModes.join(', ')})`
    : chosen.source;

  // 4. Store target. Local mode is two-tier: { home, project }.
  let storeTarget = null;
  if (chosen.mode === 'local') {
    storeTarget = { home: home || null, project: projectDirFrom({ env, userConfig, repoConfig, root }) };
  } else if (chosen.mode === 'remote') {
    storeTarget = connection.endpoint || null;
  }

  // 5. Write-behaviour properties resolved from config layers.
  //    `tags.default` — both layers merged, user supplements repo (no override).
  const tagsDefault = [
    ...asList(repoConfig['tags.default']),
    ...asList(userConfig['tags.default']),
  ].filter((t) => typeof t === 'string' && t.length > 0);

  // `ttl.default` — days until a write that named no TTL expires. A SCALAR
  //    policy, so it cannot merge the way `tags.default` does: repo wins over
  //    user, matching `hooks.adapter`. Read as "the project decided how long its
  //    lore stays fresh"; a user who disagrees can still pass --ttl-days or
  //    --clear-ttl per write, which always outranks config.
  //
  //    Deliberately NOT validated here. `resolveControl` is the pure resolver
  //    every command calls, including read-only ones — a `"ttl.default": 900`
  //    typo must not make `lorekit list` throw. The value is bounds-checked at
  //    the point of use (resolveDefaultTtlDays), where an invalid one degrades
  //    to "no default".
  //
  //    Which is exactly why the LAYER is chosen before the value is parsed (see
  //    declaresScalar): "repo wins" has to hold for a repo value that is wrong,
  //    or a typo'd project policy silently becomes a per-machine one instead of
  //    degrading to "no default". An absent key and an explicit `null` still
  //    fall through to the user layer — only a declared, usable-looking value
  //    claims the decision.
  const ttlDefaultRaw = declaresScalar(repoConfig['ttl.default'])
    ? repoConfig['ttl.default']
    : userConfig['ttl.default'];
  const ttlDefault = firstNumber(ttlDefaultRaw);

  // `scope.defaults` — repo layer only (team-scoped write policy).
  //    Schema: { "<scope-prefix>": { "tags": [...], "ttl_days": <n> | null } }
  //    Matched against a write's resolved scope using startsWith — no glob dep.
  //    `ttl_days: null` is meaningful (permanent), so a per-scope entry can opt
  //    out of `ttl.default` — see resolveDefaultTtlDays.
  const scopeDefaults =
    repoConfig['scope.defaults'] && typeof repoConfig['scope.defaults'] === 'object'
      ? repoConfig['scope.defaults']
      : null;

  // `hooks.disabled` — union of both layers (either layer can suppress an event).
  const hooksDisabled = new Set([
    ...asList(repoConfig['hooks.disabled']),
    ...asList(userConfig['hooks.disabled']),
  ]);

  // `hooks.stop` — repo layer wins over user layer, default `friction`. Gates the
  // end-of-turn retrospective: friction-only (default), always, or off.
  const hooksStop =
    normalizeStopMode(repoConfig['hooks.stop']) ||
    normalizeStopMode(userConfig['hooks.stop']) ||
    'friction';

  // `hooks.userPrompt` — repo layer wins over user layer, default `on`.
  //
  // Default-on is safe because for an `install` the WIRING is the real switch:
  // the event is installed by hook mode `all` alone, so a user who chose
  // `read-only` or `none` never reaches this resolution at all, and someone who
  // chose `all` opted into per-turn relevance — making them opt in twice would
  // leave it dark for everyone who never read the config reference. A
  // marketplace-plugin install has no mode and wires the event unconditionally,
  // so there this key is the whole opt-out; that is why it stays a real config
  // key rather than being folded into the hook mode.
  const hooksUserPrompt =
    normalizeUserPromptMode(repoConfig['hooks.userPrompt']) ||
    normalizeUserPromptMode(userConfig['hooks.userPrompt']) ||
    'on';

  // `hooks.sessionStart` — repo layer wins over user layer, default `hybrid`.
  // Chooses the SHAPE of the injected block (see SESSION_START_MODES). An
  // unrecognised value falls through to the next layer and finally to the
  // default, exactly like `hooks.stop`: a mistyped shape must degrade to the
  // sensible one, never blank the injection.
  const hooksSessionStart =
    normalizeSessionStartMode(repoConfig['hooks.sessionStart']) ||
    normalizeSessionStartMode(userConfig['hooks.sessionStart']) ||
    'hybrid';

  // `hooks.sessionStart.maxChars` — the character budget that block may spend.
  //
  // The LAYER is chosen before the value is parsed, the `ttl.default` rule (see
  // declaresScalar): a repo that declared a budget owns the decision even when
  // the value it declared is garbage, so a typo degrades to the default rather
  // than silently handing the decision to whatever the developer happens to have
  // in their home directory. Two people on the same commit must get the same
  // block.
  const sessionStartMaxCharsRaw = declaresScalar(repoConfig['hooks.sessionStart.maxChars'])
    ? repoConfig['hooks.sessionStart.maxChars']
    : userConfig['hooks.sessionStart.maxChars'];
  const hooksSessionStartMaxChars =
    normalizeSessionStartMaxChars(sessionStartMaxCharsRaw) ?? DEFAULT_SESSION_START_MAX_CHARS;

  // `hooks.sessionStart.loopCap` — how many lessons one `loop::<bucket>` may
  // contribute. Same layer-before-parse rule as maxChars (declaresScalar): a repo
  // that declared a cap owns it even when the value is garbage, so two people on
  // the same commit get the same read. `0` is a valid, deliberate value, so the
  // default is only substituted when NOTHING usable was declared.
  const sessionStartLoopCapRaw = declaresScalar(repoConfig['hooks.sessionStart.loopCap'])
    ? repoConfig['hooks.sessionStart.loopCap']
    : userConfig['hooks.sessionStart.loopCap'];
  const normalizedLoopCap = normalizeSessionStartLoopCap(sessionStartLoopCapRaw);
  const hooksSessionStartLoopCap =
    normalizedLoopCap === null ? DEFAULT_SESSION_START_LOOP_CAP : normalizedLoopCap;

  // `hooks.sessionStart.maxLessons` — how many LINES that block may hold. Same
  // layer-before-parse rule as maxChars/loopCap (declaresScalar), for the same
  // reason: a repo that declared a ceiling owns it even when the value is
  // garbage, so two people on the same commit read the same block.
  const sessionStartMaxLessonsRaw = declaresScalar(repoConfig['hooks.sessionStart.maxLessons'])
    ? repoConfig['hooks.sessionStart.maxLessons']
    : userConfig['hooks.sessionStart.maxLessons'];
  const hooksSessionStartMaxLessons =
    normalizeSessionStartMaxLessons(sessionStartMaxLessonsRaw) ?? DEFAULT_SESSION_START_MAX_LESSONS;

  // `hooks.sessionStart.branchHint` — whether the read is nudged toward the git
  // branch topic. On/off (the `hooks.userPrompt` vocabulary), default `on`, repo
  // layer wins. Off restores the pre-branch-query read: recency + salience only.
  const hooksSessionStartBranchHint =
    normalizeUserPromptMode(repoConfig['hooks.sessionStart.branchHint']) ||
    normalizeUserPromptMode(userConfig['hooks.sessionStart.branchHint']) ||
    'on';

  // `hooks.adapter` — repo layer wins over user layer (explicit project override).
  const hooksAdapter =
    (typeof repoConfig['hooks.adapter'] === 'string' && repoConfig['hooks.adapter'].trim()) ||
    (typeof userConfig['hooks.adapter'] === 'string' && userConfig['hooks.adapter'].trim()) ||
    null;

  // `hooks.instructions` — per-event custom text appended to the hook output so
  // teams can embed project-specific guidance directly into the injected context.
  // Both layers contribute: repo instructions come first, user instructions follow
  // (same direction as `tags.default` — repo supplements, user personalises).
  // null for a given event means "no custom instruction for that event".
  const hooksInstructions = {};
  {
    const repoInstr =
      (repoConfig['hooks.instructions'] && typeof repoConfig['hooks.instructions'] === 'object')
        ? repoConfig['hooks.instructions'] : {};
    const userInstr =
      (userConfig['hooks.instructions'] && typeof userConfig['hooks.instructions'] === 'object')
        ? userConfig['hooks.instructions'] : {};
    for (const ev of HOOK_INSTRUCTION_EVENTS) {
      const parts = [repoInstr[ev], userInstr[ev]]
        .filter((v) => typeof v === 'string' && v.trim().length > 0);
      hooksInstructions[ev] = parts.length > 0 ? parts.join('\n') : null;
    }
  }

  return {
    mode: chosen.mode,
    storeTarget,
    decidedBy,
    denies,
    connection,
    tagsDefault,
    ttlDefault,
    scopeDefaults,
    hooksDisabled,
    hooksStop,
    hooksUserPrompt,
    hooksSessionStart,
    hooksSessionStartMaxChars,
    hooksSessionStartLoopCap,
    hooksSessionStartMaxLessons,
    hooksSessionStartBranchHint,
    hooksAdapter,
    hooksInstructions,
  };
}

// The per-repo project-tier directory: $LOREKIT_STORE, else a `store` override
// in either config layer, else the default `.lorekit/` at the repo root.
function projectDirFrom({ env, userConfig, repoConfig, root }) {
  const raw = env.LOREKIT_STORE || userConfig.store || repoConfig.store || '.lorekit';
  return path.isAbsolute(raw) ? raw : path.join(root, raw);
}

// Resolve both local-tier directories with IO (reads the config files for a
// `store` override). Used by `migrate` so it works regardless of the active
// mode. `home` is the per-user tier root; `project` is the opt-in repo tier.
export function localStoreDirs(root = process.cwd(), env = process.env) {
  const home = userConfigDir(env);
  const userConfig = readJson(path.join(home, 'config.json'));
  const repoConfig = readJson(path.join(root, '.lorekit.json'));
  return { home, project: projectDirFrom({ env, userConfig, repoConfig, root }) };
}

// Resolve the deny-wins ceiling for the read commands: which section (offline /
// remote) is forbidden outright by an active `deny` constraint. A deny is never
// overridable (see the module header), so this is the single seam `list`,
// `search`, `show`, `stats`, and `diff` share instead of each re-deriving the
// same `control.denies.find(...)` block. Returns the matched deny object
// ({ mode, source }) or null per side — the `source` explains the "why" in each
// command's graceful note. Thin wrapper over `loadControl`, co-located with it.
export function resolveDenies(root, { env = process.env } = {}) {
  const control = loadControl(root, { env });
  const find = (mode) => control.denies.find((d) => d.mode === mode) || null;
  return { localDenied: find('local'), remoteDenied: find('remote') };
}

// IO wrapper — load env + config files, derive the connection, then resolve.
export function loadControl(root, { env = process.env } = {}) {
  const home = userConfigDir(env);
  const userConfig = readJson(path.join(home, 'config.json'));
  const repoConfig = readJson(path.join(root, '.lorekit.json'));
  const conn = resolveProjectConnection(root, splitEndpoint);
  const usable = Boolean(
    conn.endpoint && conn.token && !String(conn.endpoint).includes('<project-ref>'),
  );
  const connection = { endpoint: conn.endpoint, token: conn.token, usable };
  return resolveControl({ env, userConfig, repoConfig, connection, root, home });
}

// The per-user home tier root (also holds config.json): $LOREKIT_HOME, default
// `~/.lorekit`. Moved from the old `~/.agent-memory` location.
function userConfigDir(env) {
  return env.LOREKIT_HOME || path.join(os.homedir(), '.lorekit');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}
