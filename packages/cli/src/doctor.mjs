// `lorekit doctor` — verify the skill install and the resolved memory backend.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  SKILLS,
  resolveProjectRoot,
  skillInstallDir,
  CLAUDE_HOOK_EVENTS,
  installedHookEvents,
  hookModeFromEvents,
  missingHookEvents,
  readLorekitServer,
  readMcpConfig,
  tokenKind,
  readLorekitJson,
} from './config.mjs';
import { splitEndpoint } from './mcp.mjs';
import {
  resolveTelemetryConfig,
  resolveTelemetryTokenSource,
  probeTelemetryExport,
} from './telemetry.mjs';
import { describeIdentity } from './telemetry-identity.mjs';
import { deriveScope } from './scope.mjs';
import { loadControl, HOOK_INSTRUCTION_EVENTS } from './control.mjs';
import { createStore } from './store/index.mjs';
import { log, heading, status, c } from './util.mjs';

const AUTH_CODES = new Set([401, 403, -32001]);

export async function doctor(args) {
  const root = resolveProjectRoot(args.dir);
  let failures = 0;
  let warnings = 0;
  const failedChecks = [];
  const record = (kind, label, detail) => {
    if (kind === 'fail') { failures++; failedChecks.push(label); }
    if (kind === 'warn') warnings++;
    status(kind, label, detail);
  };

  heading('LoreKit doctor');
  log(`  project: ${c.dim(root)}\n`);

  // 0. `--telemetry` is a FOCUSED run, not a modifier on the full sweep.
  //
  // It exists to be a CI gate on one specific credential — the Dash0
  // ingesting-only OTLP token — and a bare runner has no skills installed, no
  // .mcp.json and no LoreKit API token, so a full sweep there fails for four
  // unrelated reasons and tells you nothing about the one thing being gated.
  // Returning early keeps the exit code a clean answer to a single question:
  // "can this build still emit telemetry?"
  if (args.telemetry) {
    await checkTelemetryExport(args, root, record);
    return summarize(failures, warnings, failedChecks, 'Telemetry export is working.');
  }

  // 1. Runtime.
  const major = Number(process.versions.node.split('.')[0]);
  record(
    major >= 18 ? 'pass' : 'fail',
    'node runtime',
    `v${process.versions.node}${major < 18 ? ' — need v18+ for fetch' : ''}`,
  );

  // 2. Skills installed — check every skill the CLI ships, in BOTH the project
  // and the global (~/.claude) locations. `lorekit install --global` writes the
  // skill under home, not the repo, so a project-only check reports a healthy
  // global install as "not found" (exactly the false FAIL a --global setup would
  // hit).
  for (const skill of SKILLS) {
    const skillMd = [
      skillInstallDir(root, 'project', skill.name),
      skillInstallDir(root, 'global', skill.name),
    ]
      .map((dir) => path.join(dir, 'SKILL.md'))
      .find((p) => fs.existsSync(p));
    if (skillMd) {
      const rel = path.relative(root, skillMd);
      record('pass', `skill ${skill.name}`, rel && !rel.startsWith('..') ? rel : prettyPath(skillMd));
    } else {
      record('fail', `skill ${skill.name}`, 'not found — run `lorekit install`');
    }
  }

  // 2.4. Which hooks are actually wired, and where. Hooks are an install-time
  // CHOICE (`--hooks all|read-only|none`, or the prompt), so "why does nothing
  // get remembered?" is answered HERE — without a positive report the only way
  // to tell a deliberate `none` from a broken install is to read settings.json.
  {
    const perScope = ['project', 'global']
      .map((s) => ({ scope: s, events: installedHookEvents(root, s) }))
      .filter((entry) => entry.events.length > 0);
    if (perScope.length === 0) {
      record(
        'info',
        'hooks',
        'none wired — the skills work, but memory is model-invoked only. ' +
          'Run `lorekit install --hooks all` to wire them.',
      );
    } else {
      for (const { scope, events } of perScope) {
        // An install predating a lifecycle event still READS as its mode, so
        // reporting the mode alone tells a legacy wiring it is current — the
        // one state where this line is actively misleading. Stay a `pass` (the
        // wiring works, it is just not the full set any more) and name the
        // upgrade the same way `install`'s already-installed summary does, via
        // the same `missingHookEvents` derivation.
        const mode = hookModeFromEvents(events);
        const missing = missingHookEvents(events);
        // Name the SCOPE in the command. `install` prompts for project vs
        // global when neither flag is given, so a bare command offered against
        // a `hooks global` gap can just as easily rewire the project and leave
        // the gap exactly where it was.
        const upgrade = missing.length > 0
          ? ` — missing ${missing.join(', ')}; run \`lorekit install --${scope} --hooks ${mode}\` to wire ${missing.length === 1 ? 'it' : 'them'}`
          : '';
        record('pass', `hooks ${scope}`, `${mode} — ${events.join(', ')}${upgrade}`);
      }
    }
  }

  // 2.5. Duplicate-hook detection — warn when the same lorekit hook event is
  // wired in both the project settings and the global settings. This causes
  // Claude Code to fire the hook twice per event, producing doubled terminal
  // output. Common after running `lorekit install` once with --project and
  // once with --global (or via the marketplace plugin on top of a CLI install).
  const dupeEvents = detectDuplicateHooks(root);
  if (dupeEvents.length > 0) {
    record(
      'warn',
      'hooks duplicate',
      `${dupeEvents.join(', ')} registered in BOTH project and global settings — ` +
        `Claude Code fires them twice. Remove one scope: ` +
        `run \`lorekit uninstall --project\` or \`lorekit uninstall --global\`.`,
    );
  }

  // 3. Resolved control model — which mode, and who decided it.
  const control = loadControl(root, { env: withOverrides(args) });
  record('info', 'memory mode', `${control.mode}  ${c.dim('— decided by ' + control.decidedBy)}`);
  for (const d of control.denies) {
    record('info', 'deny constraint', `${d.mode} forbidden by ${d.source}`);
  }

  // 4. Mode-specific checks.
  if (control.mode === 'off') {
    record('info', 'memory', 'disabled — hooks and the skill are silent no-ops');
  } else if (control.mode === 'local') {
    await checkLocal(control, root, args, record);
  } else {
    await checkRemote(control, root, args, record);
  }

  // 4b. BYOD storage connectivity check.
  await checkBYODStorage(record);

  // 4c. Dash0 telemetry export — is the CLI's own phone-home still working?
  await checkTelemetryExport(args, root, record);

  // 5. Scope.
  const scope = deriveScope(root);
  if (scope.hasRemote) {
    log('');
    record('info', 'read scope', scope.readOrder.join('  →  '));
    record('info', 'write scope', `${scope.repoScope} (default write target)`);
  } else {
    record('warn', 'scope', 'no git remote here — memories fall back to global');
  }

  // 6. Hook instructions — show resolved per-event custom instructions when any are set.
  {
    const instr = control.hooksInstructions || {};
    const configured = HOOK_INSTRUCTION_EVENTS.filter((ev) => instr[ev]);
    if (configured.length > 0) {
      for (const ev of HOOK_INSTRUCTION_EVENTS) {
        const text = instr[ev];
        if (text) {
          record('info', `hooks.instructions.${ev}`, c.dim(text.length > 80 ? text.slice(0, 77) + '…' : text));
        } else {
          record('info', `hooks.instructions.${ev}`, c.dim('(not set)'));
        }
      }
    }
  }

  // 7. doctor.require — committed list of checks that MUST pass.
  //    Useful as a CI gate: any check in the list that did not pass causes a failure.
  const lorekitJson = readLorekitJson(root);
  const required = (Array.isArray(lorekitJson['doctor.require']) ? lorekitJson['doctor.require'] : [])
    .filter((r) => typeof r === 'string');
  for (const req of required) {
    // A required check passes if its label is NOT in failedChecks (it either
    // passed or was never run; unknown labels get a pass to avoid false failures).
    if (failedChecks.includes(req)) {
      record('fail', 'doctor.require', `required check failed: ${req}`);
    } else {
      record('pass', 'doctor.require', `required check passed: ${req}`);
    }
  }

  return summarize(failures, warnings, failedChecks);
}

/**
 * Print the Summary block and build doctor's `{ exitCode, ...extra }` return.
 * Extracted so the focused `--telemetry` run and the full sweep end the same
 * way — same summary line, same exit-code rule, same bounded telemetry extra.
 */
function summarize(failures, warnings, failedChecks, ready = 'LoreKit memory is ready.') {
  heading('Summary');
  if (failures === 0 && warnings === 0) {
    log(`  ${c.green('All checks passed.')} ${ready}`);
  } else {
    log(
      `  ${failures ? c.red(failures + ' failed') : c.green('0 failed')}, ${
        warnings ? c.yellow(warnings + ' warning(s)') : '0 warnings'
      }.`,
    );
  }
  const exitCode = failures === 0 ? 0 : 1;
  return { exitCode, 'lorekit.cli.doctor.failed_checks': failedChecks };
}

// Merge doctor's --endpoint / --token flags into the env the resolver reads, so
// an explicit connection flag is honoured without a separate resolution path.
function withOverrides(args) {
  const env = { ...process.env };
  if (args.endpoint) env.LOREKIT_MCP_URL = args.endpoint;
  if (args.token) env.LOREKIT_TOKEN = args.token;
  if (args.mode) env.LOREKIT_MODE = args.mode;
  if (args.store) env.LOREKIT_STORE = args.store;
  return env;
}

// Abbreviate the user's home directory to `~` for readable paths.
function prettyPath(p) {
  const home = os.homedir();
  return p && home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

async function checkLocal(control, root, args, record) {
  const store = createStore(control);
  const scope = deriveScope(root);
  const scopes = [...new Set([...scope.readOrder, scope.branchScope, scope.repoScope])].filter(
    Boolean,
  );

  // Home tier — per-user, cross-repo, always available.
  record('pass', 'home store', prettyPath(store.homeDir));
  const homeCount = await store.home.count(scopes);
  record('info', 'home entries', `${homeCount} ${homeCount === 1 ? 'memory' : 'memories'}`);

  // Project tier — opt-in; active only when its directory exists.
  const projRel = path.relative(root, store.projectDir) || store.projectDir;
  if (store.projectActive()) {
    const sharing = gitTracked(root, store.projectDir)
      ? 'committed — shared with the team'
      : 'gitignored — private to your checkout';
    record('pass', 'project store', projRel);
    const projCount = await store.project.count(scopes);
    record('info', 'project entries', `${projCount} ${projCount === 1 ? 'memory' : 'memories'} — ${sharing}`);
  } else {
    record(
      'info',
      'project store',
      `${projRel} — not opted-in (create it to persist repo/branch memories here)`,
    );
  }

  if (args.deep) await deepCheckLocal(store, scope, record);
}

async function checkRemote(control, root, args, record) {
  const override = { endpoint: args.endpoint || null, token: args.token || null };
  const mcp = readMcpConfig(root);
  const configured = mcp.valid ? readLorekitServer(root) : null;
  const fromMcp = configured ? splitEndpoint(configured.url) : { endpoint: null, token: null };

  const endpoint = override.endpoint || fromMcp.endpoint || control.connection.endpoint;
  const token = override.token || fromMcp.token || control.connection.token;

  if (mcp.present && !mcp.valid) {
    record('fail', '.mcp.json', 'invalid JSON — fix it or re-run `lorekit install`');
  } else if (configured) {
    record('pass', '.mcp.json', 'lorekit server configured');
  } else {
    record('warn', '.mcp.json', 'no lorekit server entry — using env/flags');
  }

  if (!endpoint) {
    record('fail', 'endpoint', 'none — set it in .mcp.json or pass --endpoint');
  } else if (endpoint.includes('<project-ref>')) {
    record('fail', 'endpoint', `still a placeholder: ${endpoint}`);
  } else {
    record('pass', 'endpoint', endpoint);
  }

  const kind = tokenKind(token);
  if (kind === 'none') record('fail', 'token', 'none configured');
  else if (kind === 'read-only') record('warn', 'token', 'read-only (lk_ro_*) — reads only, no writes');
  else if (kind === 'write-only') record('warn', 'token', 'write-only (lk_wo_*) — writes only, no reads');
  else if (kind === 'unknown') record('warn', 'token', 'unrecognized prefix (expected lk_rw_* / lk_ro_* / lk_wo_*)');
  else record('pass', 'token', 'read+write (lk_rw_*)');

  // Connectivity, through the store.
  const store = createStore({ mode: 'remote', connection: { endpoint, token } });
  if (endpoint && !endpoint.includes('<project-ref>') && token) {
    const res = await store.ping();
    if (res.networkError) {
      record('fail', 'connectivity', res.networkError);
    } else if (res.ok) {
      // Say what the probe actually proved. `ping()` hits the PUBLIC `/health`
      // function and returns only `{ ok, httpStatus }` — never a tool list — so
      // "reachable" is a statement about the network path alone. The token itself
      // is judged by the `authentication` check below.
      record('pass', 'connectivity', 'reachable (public health probe — token not checked)');
    } else if (res.error && AUTH_CODES.has(res.error.code)) {
      record('fail', 'connectivity', `auth rejected (${res.error.code}) — check your token`);
    } else if (res.error) {
      record('warn', 'connectivity', `reachable, server said: ${res.error.message || res.error.code}`);
    } else {
      record('warn', 'connectivity', `unexpected response (HTTP ${res.httpStatus})`);
    }

    await checkRemoteAuth(store, record);

    if (args.deep) await deepCheckRemote(store, root, record);
  } else {
    record('warn', 'connectivity', 'skipped — need a valid endpoint and token');
    record('warn', 'authentication', 'skipped — need a valid endpoint and token');
  }
}

/**
 * Does the configured token STILL work?
 *
 * The `token` check above only reads the PREFIX (`lk_rw_`/`lk_ro_`/`lk_wo_`)
 * and `connectivity` probes the PUBLIC `/health` function, so both stay green
 * for a token that has been revoked in the dashboard — which is precisely the
 * state a user runs doctor in. This check makes one authenticated,
 * side-effect-free request and reports what the server said about the
 * credential itself.
 *
 * A revoked token is a FAIL (doctor exits non-zero): every remote read and
 * write is broken, which is not a warning-level condition. A token that is
 * accepted but lacks read permission is a PASS — that is the healthy state of a
 * write-only token, and the `token` check already describes the tradeoff.
 */
async function checkRemoteAuth(store, record) {
  const res = await store.verifyAuth();

  if (res.networkError) {
    record('warn', 'authentication', `could not verify — ${res.networkError}`);
    return;
  }
  if (res.unusable) {
    record('warn', 'authentication', 'skipped — need a valid endpoint and token');
    return;
  }
  if (res.authenticated === false) {
    record(
      'fail',
      'authentication',
      'token REJECTED by the server (HTTP 401) — it has been revoked, deleted, or was never valid. ' +
        'Create a new one at https://lorekit.io/settings, then run `lorekit install --force` to replace it.',
    );
    return;
  }
  if (res.rateLimited) {
    record('warn', 'authentication', 'could not verify — the request was rate limited (HTTP 429) before it reached the route; retry shortly');
    return;
  }
  if (res.authenticated === true) {
    record(
      'pass',
      'authentication',
      res.permitted ? 'token accepted — read access confirmed' : 'token accepted — no read permission (write-only token)',
    );
    return;
  }
  const detail = res.error ? res.error.message || res.error.code : `HTTP ${res.httpStatus}`;
  record('warn', 'authentication', `inconclusive — server said: ${detail}`);
}

async function deepCheckRemote(store, root, record) {
  if (tokenKind(store.token) !== 'read-write') {
    record('warn', 'round-trip', 'skipped — needs a read+write token');
    return;
  }
  const scope = deriveScope(root);
  const writeScope = scope.repoScope || 'global';
  const key = 'lorekit-memory::doctor-check';

  const w = await store.write({
    scope: writeScope,
    key,
    value: 'LoreKit doctor round-trip check. Safe to delete.',
    tags: ['skill::lorekit-memory', 'source::doctor'],
    trigger: 'manual',
  });
  if (!w.ok) {
    record('fail', 'round-trip', `write failed: ${w.error ? w.error.message || w.error.code : w.networkError}`);
    return;
  }
  // Everything after a SUCCESSFUL write runs under `finally`, because this
  // probe writes to the user's REAL project (CI runs it against production on
  // every deploy). A throw or an early return between the write and the delete
  // leaves a synthetic row in that tenant with nothing to remove it — the read
  // is a diagnostic, never a reason to abandon the row it created.
  try {
    const r = await store.read({ scope: writeScope, key });
    const readBack = r.ok && JSON.stringify(r.entry || '').includes('round-trip');
    record(
      readBack ? 'pass' : 'warn',
      'round-trip',
      readBack ? `wrote + read back in ${writeScope}` : 'wrote, but read-back was inconclusive',
    );
  } finally {
    await removeProbeRow(store, writeScope, key, record);
  }
}

/**
 * Delete the probe row, reporting rather than swallowing a failure.
 *
 * A silent `.catch` here means a synthetic row left in the user's REAL project
 * with no signal anywhere — the same class of invisible leak this cleanup work
 * exists to end. It is a `warn`, not a `fail`: the round-trip the user asked
 * about did happen, so this must not flip doctor's verdict; it must just be
 * impossible to miss. Both the thrown case and the `{ ok: false }` case are
 * covered, because a REST delete reports its failure in the return value.
 */
async function removeProbeRow(store, writeScope, key, record) {
  try {
    const d = await store.delete({ scope: writeScope, key, force: true });
    if (d && d.ok === false) {
      record('warn', 'round-trip cleanup', `could not remove ${writeScope}::${key} — delete it manually`);
    }
  } catch (err) {
    record('warn', 'round-trip cleanup', `could not remove ${writeScope}::${key}: ${err && err.message ? err.message : err}`);
  }
}

async function deepCheckLocal(store, scope, record) {
  const writeScope = scope.repoScope || 'global';
  const key = 'lorekit-memory::doctor-check';
  const w = await store.write({
    scope: writeScope,
    key,
    value: 'LoreKit doctor round-trip check. Safe to delete.',
    tags: ['skill::lorekit-memory', 'source::doctor'],
    trigger: 'manual',
  });
  // Same `finally` contract as the remote probe: the local store is a real
  // store too, and a half-finished probe should not leave a row in it.
  try {
    const r = await store.read({ scope: writeScope, key });
    const readBack = w.ok && r.ok && r.entry && String(r.entry.value).includes('round-trip');
    record(
      readBack ? 'pass' : 'warn',
      'round-trip',
      readBack ? `wrote + read back in ${writeScope}` : 'write/read-back was inconclusive',
    );
  } finally {
    await removeProbeRow(store, writeScope, key, record);
  }
}

// Returns the list of CLAUDE_HOOK_EVENTS whose lorekit hook command appears in
// BOTH the project settings file (.claude/settings.json) and the global one
// (~/.claude/settings.json). An empty array means no duplicates — healthy.
//
// Both sides read through `installedHookEvents`, the SAME detection `install`
// uses to preselect its hook prompt, so the two surfaces can never disagree
// about what is wired.
function detectDuplicateHooks(root) {
  const inProject = new Set(installedHookEvents(root, 'project'));
  const inGlobal = new Set(installedHookEvents(root, 'global'));
  return CLAUDE_HOOK_EVENTS.filter((event) => inProject.has(event) && inGlobal.has(event));
}

/**
 * Is the CLI's own OpenTelemetry export still working?
 *
 * This is a DIFFERENT credential from the `token` / `authentication` checks
 * above: those verify the LoreKit API token (`lk_rw_*`) that reads and writes
 * memories. This one verifies the Dash0 ingesting-only OTLP token, which is
 * baked into the published tarball at release time and is otherwise invisible —
 * `exportInvocation` swallows every transport error by design, so a revoked
 * token, a moved endpoint, or a release that published with the
 * `LOREKIT_TELEMETRY_TOKEN` secret unset all look identical from the outside:
 * silence. Nothing in CI noticed, because nothing was looking.
 *
 * Two tiers, so the default `doctor` run stays offline and side-effect-free:
 *   • always — report whether export is ON and where the credential came from,
 *     as `info`. Never a failure: end users legitimately opt out, and a user's
 *     machine having no phone-home is not a broken install.
 *   • `--telemetry` — actually POST a probe span and assert the endpoint
 *     accepted it. Here a dead export IS a failure; that flag is what CI passes.
 */
async function checkTelemetryExport(args, root, record) {
  const required = Boolean(args.telemetry);

  let config;
  try {
    // Read `.lorekit.json` from the SAME root every other check uses. Left to
    // its default, `resolveTelemetryConfig` reads it from `process.cwd()`, so a
    // `telemetry.disabled` in the shell's directory would decide the verdict for
    // an unrelated `--dir`.
    config = resolveTelemetryConfig(process.env, readLorekitJson(root));
  } catch {
    config = { enabled: false, reason: 'error' };
  }
  const source = resolveTelemetryTokenSource();

  if (!config.enabled) {
    // Report the reason `resolveTelemetryConfig` actually returned. Deriving it
    // from the token source instead misreports every case where a credential
    // variable is set but unusable — e.g. an OTEL_EXPORTER_OTLP_HEADERS that
    // parses to zero headers, which is a broken credential, not an opt-out.
    const detail =
      config.reason === 'opted-out'
        ? 'export off — opted out via LOREKIT_TELEMETRY / DO_NOT_TRACK / `telemetry.disabled` in .lorekit.json'
        : config.reason === 'no-endpoint'
          ? 'export off — no OTLP endpoint resolved. Published tarballs get one baked in at release; ' +
            'set OTEL_EXPORTER_OTLP_ENDPOINT to override.'
          : config.reason === 'error'
            ? 'export off — the telemetry config could not be resolved'
            : 'export off — no OTLP credential resolved. Published tarballs get one injected at release; ' +
              'set LOREKIT_TELEMETRY_TOKEN (or OTEL_EXPORTER_OTLP_HEADERS) to override.';
    record(required ? 'fail' : 'info', 'telemetry', detail);
    return;
  }

  record('info', 'telemetry', `export on → ${config.endpoint} ${c.dim(`(credential from ${source})`)}`);

  // What identity the exported telemetry carries, and where it lives. Reported
  // because the id is otherwise invisible: it is minted silently on first run,
  // and a user who wants to see or reset it needs the path. `describeIdentity`
  // never mints, so running `doctor` cannot itself create the file — the line
  // below reads "not yet minted" on a machine that has only ever run `doctor`.
  const identity = describeIdentity();
  const linked = identity.accountId
    ? `account ${identity.accountId}`
    : 'no account linked yet — any authenticated command links it';
  record(
    'info',
    'telemetry',
    identity.installId
      ? `identity: install ${identity.installId} · ${linked} ${c.dim(`(${identity.file} — delete to reset)`)}`
      : `identity: not yet minted ${c.dim(`(will be written to ${identity.file})`)}`,
  );

  // The probe writes a real span to a real backend — only on explicit request.
  if (!required) return;

  const probe = await probeTelemetryExport(config, { version: cliVersion(), timeoutMs: 5000 });

  if (probe.networkError) {
    record('fail', 'telemetry export', `could not reach ${config.endpoint} — ${probe.networkError}`);
  } else if (probe.unauthorized) {
    record(
      'fail',
      'telemetry export',
      `probe span REJECTED (HTTP ${probe.httpStatus}) — the OTLP token is revoked, expired, or was never valid. ` +
        'Mint a new Dash0 ingesting-only token and update the LOREKIT_TELEMETRY_TOKEN secret.',
    );
  } else if (probe.rejectedSpans) {
    // A 2xx that dropped the span. Reporting the bare status here would read as
    // a contradiction ("rejected (HTTP 200)"), so name the partial-success
    // envelope the collector actually answered with.
    record(
      'fail',
      'telemetry export',
      `probe span REJECTED by the collector (HTTP ${probe.httpStatus}, partialSuccess.rejectedSpans=${probe.rejectedSpans}) — ` +
        'the endpoint answered success but did not ingest the span' +
        (probe.rejectionMessage ? `: ${probe.rejectionMessage}` : '.'),
    );
  } else if (probe.ok) {
    record('pass', 'telemetry export', `probe span accepted (HTTP ${probe.httpStatus}) — the token can ingest`);
  } else {
    record('fail', 'telemetry export', `probe span rejected (HTTP ${probe.httpStatus})`);
  }
}

/** The running CLI version, for stamping the telemetry probe span. */
function cliVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

async function checkBYODStorage(record) {
  const storageUrl = process.env['LOREKIT_STORAGE_URL'];
  const storageAnonKey = process.env['LOREKIT_STORAGE_ANON_KEY'];

  if (!storageUrl && !storageAnonKey) {
    return; // No BYOD configured — skip silently.
  }

  if (storageUrl && !storageAnonKey) {
    record('fail', 'byod storage', 'LOREKIT_STORAGE_URL is set but LOREKIT_STORAGE_ANON_KEY is missing');
    return;
  }

  if (!storageUrl && storageAnonKey) {
    record('fail', 'byod storage', 'LOREKIT_STORAGE_ANON_KEY is set but LOREKIT_STORAGE_URL is missing');
    return;
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(storageUrl, storageAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await db.from('memories').select('id').limit(1);
    if (error && error.code !== '42P01') {
      record('fail', 'byod storage', `connectivity error: ${error.message}`);
    } else {
      record('pass', 'byod storage', `ok — ${storageUrl}`);
    }
  } catch (e) {
    record('fail', 'byod storage', `could not connect: ${e && e.message ? e.message : String(e)}`);
  }
}

function gitTracked(root, dir) {
  // Heuristic: is the store dir ignored by git? If `git check-ignore` names it,
  // it is private; otherwise it will be committed (team-shared).
  try {
    execFileSync('git', ['check-ignore', '-q', dir], { cwd: root, stdio: 'ignore' });
    return false; // ignored → private
  } catch {
    return true; // not ignored → tracked/committed
  }
}
