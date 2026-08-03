// LoreKit CLI — self-contained OpenTelemetry export for command usage.
//
// The CLI is strictly zero-dependency (see packages/cli/package.json), so this
// mirrors the Edge Function's SDK-free approach (supabase/functions/_shared/
// otel.ts): OTLP/JSON over the global fetch (Node 18+), no @opentelemetry/*
// packages. One span + one counter data point per human-facing command
// (install / uninstall / doctor / list / search / show / stats / scopes / diff /
// tree / lint / dedupe / link / migrate), fired to Dash0 so the maintainers can
// see which commands people actually run.
//
// Privacy — this runs on end-users' machines, so it is deliberately narrow:
//   • Opt-out honored: LOREKIT_TELEMETRY=0|off|false|no|disable, or the
//     cross-vendor DO_NOT_TRACK=1, disables all export.
//   • No PII is ever attached: only the command name, a bounded allow-list of
//     boolean flags, the CLI/runtime/OS identity, and the outcome. Never a
//     path, cwd, token, endpoint, repo, or scope string.
//   • Disabled outright when no OTLP endpoint resolves.
//
// The default endpoint + token below are baked into the published package and
// are therefore public by design. The token MUST be Dash0 ingestion-only
// (write/POST spans, no read/query/manage) — anyone can unpack the npm tarball
// and read it. It is NOT committed to git: the release workflow injects it into
// telemetry-token.mjs at publish time from a secret (see that file). Standard
// OTEL_EXPORTER_OTLP_* env vars — or LOREKIT_TELEMETRY_TOKEN — override it.

import process from 'node:process';
import { TELEMETRY_TOKEN } from './telemetry-token.mjs';
import { readLorekitJson } from './config.mjs';

// ── Baked-in defaults (public by design) ──────────────────────────────────────
// The endpoint is a committed default; the token is injected at publish time
// (empty in the source tree, so default export stays off until built/injected).
const DEFAULT_ENDPOINT = 'https://ingress.europe-west4.gcp.dash0-dev.com';
const DEFAULT_TOKEN = TELEMETRY_TOKEN; // injected from LOREKIT_TELEMETRY_TOKEN at publish
// Ship to the `default` Dash0 dataset unless `DASH0_DATASET` overrides it, so
// CLI telemetry lands alongside every other LoreKit component (all `default`).
const DEFAULT_DATASET = 'default';

// Flags worth counting (e.g. how many installs are --global). Bounded on
// purpose: only these booleans are ever attached, never free-form values.
const FLAG_ATTRS = ['global', 'project', 'deep', 'yes', 'force', 'no-hooks', 'json', 'link'];

const OFF_VALUES = new Set(['0', 'off', 'false', 'no', 'disable', 'disabled']);

// ── Active trace context (for traceparent propagation to REST calls) ──────────
// Set at the start of EVERY traced command run — including runs where export is
// disabled. Context propagation is deliberately decoupled from export: a user
// who opted out (or who simply has no OTLP endpoint configured) must still get
// correlated server-side traces, they just don't contribute a CLI span.
let _activeTraceId = null;
let _activeSpanId = null;
// Whether the current command's span will actually be exported. Drives the
// W3C `sampled` bit only — never whether the header is sent.
let _activeSampled = false;

/**
 * Get the W3C traceparent for the currently-running CLI command, or null when
 * no command is running. Called by RemoteStore to inject the header into
 * outgoing REST/MCP calls so the server span joins the CLI's trace.
 *
 * Flags are `01` when the CLI span is exported and `00` when it is not — the
 * trace id is still carried either way, so the server can correlate. This
 * mirrors `formatTraceparent` in `packages/mcp-core/src/trace-context.ts`
 * (the CLI is zero-dep `.mjs` and cannot import the TS module); keep the two
 * byte-consistent.
 */
export function getActiveTraceparent() {
  if (!_activeTraceId || !_activeSpanId) return null;
  return `00-${_activeTraceId}-${_activeSpanId}-${_activeSampled ? '01' : '00'}`;
}

// ── Config resolution ─────────────────────────────────────────────────────────

/**
 * Resolve telemetry config from env + baked-in defaults + .lorekit.json.
 * Returns { enabled: false, reason } when disabled or unconfigured, else the
 * endpoint and headers to export with.
 *
 * `reason` names WHY export is off, because the three causes are not
 * interchangeable to a user and cannot be re-derived from the outside:
 *   • `opted-out`     — LOREKIT_TELEMETRY / DO_NOT_TRACK / `telemetry.disabled`.
 *   • `no-endpoint`   — nothing to export to.
 *   • `no-credential` — an endpoint, but no usable auth header. Note that an
 *     OTEL_EXPORTER_OTLP_HEADERS that parses to zero headers lands here, which
 *     is exactly why a caller must not infer the cause from the token source:
 *     the variable is set, yet no credential resolved.
 * @param {object} [env]  defaults to process.env
 * @param {object} [repoConfig]  pre-loaded .lorekit.json (optional; read from cwd if absent)
 */
export function resolveTelemetryConfig(env = process.env, repoConfig) {
  const optOut = env.LOREKIT_TELEMETRY;
  if (optOut !== undefined && OFF_VALUES.has(String(optOut).trim().toLowerCase())) {
    return { enabled: false, reason: 'opted-out' };
  }
  // DNT spec designates exactly `1` as the opt-out signal (consoledonottrack.com).
  // Match it precisely — a stray `DO_NOT_TRACK=false` should NOT disable export
  // (use LOREKIT_TELEMETRY for the loose app-specific opt-out values).
  if (env.DO_NOT_TRACK && String(env.DO_NOT_TRACK).trim() === '1') {
    return { enabled: false, reason: 'opted-out' };
  }
  // `telemetry.disabled: true` in .lorekit.json — team-level opt-out committed
  // to the repo. Checked after env overrides (env always wins).
  const cfg = repoConfig !== undefined ? repoConfig : readLorekitJson(process.cwd());
  if (cfg['telemetry.disabled'] === true) {
    return { enabled: false, reason: 'opted-out' };
  }

  const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_ENDPOINT || '')
    .trim()
    .replace(/\/+$/, '');
  if (!endpoint) return { enabled: false, reason: 'no-endpoint' };

  const headers = {};
  // Auth header priority (highest first):
  //   1. OTEL_EXPORTER_OTLP_HEADERS — explicit comma list of key=value.
  //   2. LOREKIT_TELEMETRY_TOKEN    — a bare bearer token via env (e.g. set as a
  //      GitHub Actions secret to inject the token, or for local testing).
  //   3. DEFAULT_TOKEN              — baked into the tarball at publish time.
  const rawHeaders = env.OTEL_EXPORTER_OTLP_HEADERS;
  const envToken = env.LOREKIT_TELEMETRY_TOKEN ? String(env.LOREKIT_TELEMETRY_TOKEN).trim() : '';
  if (rawHeaders) {
    for (const pair of String(rawHeaders).split(',')) {
      const idx = pair.indexOf('=');
      if (idx > 0) headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  } else if (envToken) {
    headers['Authorization'] = `Bearer ${envToken}`;
  } else if (DEFAULT_TOKEN) {
    headers['Authorization'] = `Bearer ${DEFAULT_TOKEN}`;
  }

  // With the baked-in default endpoint we need the baked-in token (or explicit
  // headers) to authenticate — no point exporting an unauthenticated request.
  const usingDefaultEndpoint = !env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (usingDefaultEndpoint && Object.keys(headers).length === 0) {
    return { enabled: false, reason: 'no-credential' };
  }

  // Dataset routing, highest precedence first: an explicit `Dash0-Dataset`
  // already parsed from OTEL_EXPORTER_OTLP_HEADERS wins and is never clobbered;
  // otherwise DASH0_DATASET; otherwise the baked-in DEFAULT_DATASET (`default`).
  // HTTP header names are case-insensitive, so match any casing the caller used
  // (e.g. `dash0-dataset`) rather than only the canonical spelling — otherwise a
  // second, conflicting header would be appended.
  const hasDataset = Object.keys(headers).some((k) => k.toLowerCase() === 'dash0-dataset');
  if (!hasDataset) {
    const dataset = env.DASH0_DATASET || DEFAULT_DATASET;
    if (dataset) headers['Dash0-Dataset'] = dataset;
  }

  return { enabled: true, endpoint, headers };
}

/**
 * Which source supplied the OTLP credential, for `doctor` to report. Mirrors
 * the priority order in `resolveTelemetryConfig` above — keep the two in step.
 * Returns a human-readable label, or `'none'` when nothing resolved.
 * @param {object} [env]  defaults to process.env
 */
export function resolveTelemetryTokenSource(env = process.env) {
  if (env.OTEL_EXPORTER_OTLP_HEADERS) return 'OTEL_EXPORTER_OTLP_HEADERS';
  if (env.LOREKIT_TELEMETRY_TOKEN && String(env.LOREKIT_TELEMETRY_TOKEN).trim()) {
    return 'LOREKIT_TELEMETRY_TOKEN';
  }
  if (DEFAULT_TOKEN) return 'the token baked in at publish time';
  return 'none';
}

// ── ID + value helpers (mirror _shared/otel.ts) ───────────────────────────────

export function randHex(bytes) {
  const b = new Uint8Array(bytes);
  // `crypto` here is the WebCrypto global (globalThis.crypto), a stable global
  // since Node 19 and also present on Node 18 — hence used unqualified rather
  // than imported. (Do NOT `import crypto from 'node:crypto'`: that module's
  // default export does not expose getRandomValues; only `webcrypto` does.)
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function toOtlpValue(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  return { stringValue: String(v) };
}

// Map a flat attribute bag to the OTLP key/value list shape.
function toOtlpAttributes(attributes) {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: toOtlpValue(value) }));
}

// OTel `os.type` / `host.arch` use their own bounded enum vocabularies, which
// are NOT identical to Node's `process.platform` / `process.arch` spellings.
// Node's `win32` / `sunos` and `x64` / `ia32` / `arm` are the ones that differ;
// emitting them verbatim produces off-registry attribute values that a Dash0 /
// OTel-native backend can't group with telemetry from other SDKs. Map the known
// divergences and pass anything already-canonical (or unknown) through.
//   os.type:   https://opentelemetry.io/docs/specs/semconv/registry/attributes/os/
//   host.arch: https://opentelemetry.io/docs/specs/semconv/registry/attributes/host/
const OS_TYPE_BY_PLATFORM = { win32: 'windows', sunos: 'solaris' };
// Node's `process.arch` reports `ppc` for 32-bit PowerPC; the OTel `host.arch`
// registry value for it is `ppc32` (its `ppc64` spelling already matches Node).
const HOST_ARCH_BY_PROCESS_ARCH = { x64: 'amd64', ia32: 'x86', arm: 'arm32', ppc: 'ppc32' };

/** Map a Node `process.platform` value to an OTel `os.type` registry value. */
export function normalizeOsType(platform) {
  return OS_TYPE_BY_PLATFORM[platform] ?? platform;
}

/** Map a Node `process.arch` value to an OTel `host.arch` registry value. */
export function normalizeHostArch(arch) {
  return HOST_ARCH_BY_PROCESS_ARCH[arch] ?? arch;
}

/**
 * Resolve the `deployment.environment.name` resource value, or `undefined` when
 * none is set. The CLI runs on end-users' machines, so — unlike the edge/web/
 * mcp-node deployments — it has no ambient environment and deliberately OMITS
 * the attribute by default. It is emitted ONLY when explicitly overridden via
 * `DEPLOYMENT_ENVIRONMENT` (falling back to `OTEL_DEPLOYMENT_ENVIRONMENT`) — the
 * same single, env-driven knob the edge honours, which the correlated-trace
 * harness (`scripts/emit-correlated-trace.mts`) uses to stamp `test`.
 * @param {object} [env]  defaults to process.env
 */
export function resolveDeploymentEnvironment(env = process.env) {
  const raw = env.DEPLOYMENT_ENVIRONMENT ?? env.OTEL_DEPLOYMENT_ENVIRONMENT;
  const value = raw !== undefined ? String(raw).trim() : '';
  return value || undefined;
}

function resourceAttributes(version, env = process.env) {
  const attrs = [
    { key: 'service.name', value: { stringValue: 'cli' } },
    { key: 'service.namespace', value: { stringValue: 'lorekit' } },
    { key: 'service.version', value: { stringValue: String(version) } },
    { key: 'process.runtime.name', value: { stringValue: 'nodejs' } },
    { key: 'process.runtime.version', value: { stringValue: process.versions.node } },
    { key: 'os.type', value: { stringValue: normalizeOsType(process.platform) } },
    { key: 'host.arch', value: { stringValue: normalizeHostArch(process.arch) } },
  ];
  const deploymentEnv = resolveDeploymentEnvironment(env);
  if (deploymentEnv) attrs.push({ key: 'deployment.environment.name', value: { stringValue: deploymentEnv } });
  return attrs;
}

// ── Payload builders (pure — unit-tested) ─────────────────────────────────────

/**
 * Collect the bounded, non-PII attributes for a command invocation. Only the
 * command name, allow-listed boolean flags, the outcome and the exit code.
 */
export function commandAttributes({ command, args = {}, outcome, exitCode, extraAttrs = {} }) {
  const attrs = { 'lorekit.cli.command': command, 'lorekit.cli.outcome': outcome };
  if (typeof exitCode === 'number') attrs['lorekit.cli.exit_code'] = exitCode;
  for (const flag of FLAG_ATTRS) {
    if (args[flag]) attrs[`lorekit.cli.flag.${flag}`] = true;
  }
  Object.assign(attrs, extraAttrs);
  return attrs;
}

export function buildTracePayload({ version, name, attributes, startMs, endMs, status, statusMessage, traceId, spanId }) {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(version) },
        scopeSpans: [
          {
            scope: { name: 'cli', version: String(version) },
            spans: [
              {
                traceId: traceId ?? randHex(16),
                spanId: spanId ?? randHex(8),
                name,
                kind: 1, // INTERNAL
                startTimeUnixNano: String(startMs * 1_000_000),
                endTimeUnixNano: String(endMs * 1_000_000),
                attributes: toOtlpAttributes(attributes),
                status: {
                  code: status === 'error' ? 2 : 1,
                  ...(statusMessage ? { message: statusMessage } : {}),
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

export function buildMetricsPayload({ version, attributes, startMs, endMs }) {
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes(version) },
        scopeMetrics: [
          {
            scope: { name: 'cli', version: String(version) },
            metrics: [
              {
                name: 'lorekit.cli.invocations',
                description: 'Count of LoreKit CLI command invocations',
                unit: '1',
                sum: {
                  aggregationTemporality: 1, // DELTA — a single-shot CLI reports +1
                  isMonotonic: true,
                  dataPoints: [
                    {
                      asInt: '1',
                      startTimeUnixNano: String(startMs * 1_000_000),
                      timeUnixNano: String(endMs * 1_000_000),
                      attributes: toOtlpAttributes(attributes),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

// ── Export ────────────────────────────────────────────────────────────────────

async function post(url, headers, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Telemetry is best-effort — never surface a network/abort error.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Export the trace + metric for one command. Best-effort and time-bounded so it
 * can never delay or fail the CLI. Awaited before process exit (Node would
 * otherwise drop the in-flight request), but capped at timeoutMs.
 */
export async function exportInvocation(config, { version, name, attributes, startMs, endMs, status, statusMessage, traceId, spanId }, { timeoutMs = 1500 } = {}) {
  if (!config || !config.enabled) return;
  const trace = buildTracePayload({ version, name, attributes, startMs, endMs, status, statusMessage, traceId, spanId });
  const metric = buildMetricsPayload({ version, attributes, startMs, endMs });
  await Promise.all([
    post(`${config.endpoint}/v1/traces`, config.headers, trace, timeoutMs),
    post(`${config.endpoint}/v1/metrics`, config.headers, metric, timeoutMs),
  ]);
}

/**
 * Send ONE synthetic span to the configured OTLP endpoint and report what the
 * collector said about it.
 *
 * Deliberately not routed through `post()`: command telemetry swallows every
 * error on purpose (it must never disturb the CLI), which is exactly the
 * behaviour that let export die silently. `doctor --telemetry` needs the
 * opposite — the HTTP status, so it can tell "accepted" from "token rejected"
 * from "endpoint unreachable".
 *
 * The probe span is tagged `lorekit.telemetry.probe=true` so it is trivially
 * filtered out of usage dashboards, and carries the same bounded, non-PII
 * attribute set as a real command span.
 *
 * `ok` means the span was INGESTED, not merely that the POST returned 2xx —
 * OTLP/HTTP reports a dropped span as a 2xx carrying
 * `partialSuccess.rejectedSpans`, so a status-only verdict would report a
 * rejected probe as accepted. That false green is the exact failure this probe
 * exists to catch, and the probe sends exactly one span, so any non-zero
 * `rejectedSpans` means the thing we sent was dropped.
 *
 * @returns {Promise<{skipped?: boolean, ok?: boolean, unauthorized?: boolean, httpStatus?: number, rejectedSpans?: number, rejectionMessage?: string, networkError?: string}>}
 */
export async function probeTelemetryExport(config, { version = '0.0.0', timeoutMs = 5000 } = {}) {
  if (!config || !config.enabled) return { skipped: true };

  const now = Date.now();
  const payload = buildTracePayload({
    version,
    name: 'lorekit.cli.doctor.telemetry_probe',
    attributes: {
      'lorekit.cli.command': 'doctor',
      'lorekit.cli.outcome': 'ok',
      'lorekit.telemetry.probe': true,
    },
    startMs: now,
    endMs: now,
    status: 'ok',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.endpoint}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...config.headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const httpStatus = res.status;
    const accepted = httpStatus >= 200 && httpStatus < 300;

    // A 2xx only means the collector took the REQUEST. Read the OTLP
    // partial-success envelope to find out whether it took the SPAN.
    // Deliberately one-directional: only a positively parsed, non-zero
    // `rejectedSpans` downgrades the verdict. An empty, non-JSON, or
    // unreadable body leaves the status-based answer alone, so a terse but
    // healthy collector can never be turned into a false red — and the read is
    // wrapped in its own try so a failure here cannot erase an HTTP status we
    // already have by falling into the transport `catch` below.
    let rejectedSpans = 0;
    let rejectionMessage;
    if (accepted) {
      try {
        const partial = JSON.parse(await res.text())?.['partialSuccess'];
        const count = Number(partial?.['rejectedSpans'] ?? 0);
        if (Number.isFinite(count) && count > 0) {
          rejectedSpans = count;
          const message = partial?.['errorMessage'];
          // Collector-controlled free text — bounded before it reaches output.
          if (typeof message === 'string' && message) rejectionMessage = message.slice(0, 200);
        }
      } catch {
        // Unreadable or non-OTLP body — fall back to the status alone.
      }
    }

    return {
      httpStatus,
      ok: accepted && rejectedSpans === 0,
      unauthorized: httpStatus === 401 || httpStatus === 403,
      ...(rejectedSpans > 0 ? { rejectedSpans } : {}),
      ...(rejectionMessage ? { rejectionMessage } : {}),
    };
  } catch (e) {
    const networkError =
      e && e.name === 'AbortError'
        ? `no response within ${timeoutMs}ms`
        : (e && e.message) || String(e);
    return { networkError };
  } finally {
    clearTimeout(timer);
  }
}

// ── Command wrapper ───────────────────────────────────────────────────────────

/**
 * A bounded, non-PII label for a thrown error: its `code` (e.g. `ENOENT`) or,
 * failing that, its constructor name (e.g. `TypeError`). Never the free-form
 * message, which can carry paths and other user data.
 */
function errorLabel(e) {
  if (e && typeof e.code === 'string' && e.code) return e.code;
  if (e && e.constructor && e.constructor.name) return e.constructor.name;
  return 'Error';
}

/**
 * Coerce a command handler's return value to a numeric exit code. Commands may
 * resolve to a bare number, or to an { exitCode, ...extra } object (which lets
 * them surface bounded diagnostic fields for telemetry); anything else → 0.
 * Single source of truth for exit-code normalization on both traceCommand paths.
 * @param {unknown} result
 * @returns {number}
 */
function normalizeExitCode(result) {
  if (result !== null && typeof result === 'object') return result.exitCode ?? 0;
  return result ?? 0;
}

/**
 * Time a human-facing command, record its outcome, and export one span + one
 * counter point. Returns the command's exit code unchanged. Telemetry failures
 * are swallowed — the command result is never affected.
 *
 * The span carries an ERROR status only when the command CRASHED. A command
 * that ran to completion and exited non-zero (a failing `doctor` check, a
 * `lint` finding) reports `lorekit.cli.outcome=failure` on a span the exporter
 * emits as STATUS_CODE_OK — never ERROR.
 *
 * @param {string} command  bounded: install | uninstall | doctor | list | search | show | stats | scopes | diff | tree | lint | dedupe | link | migrate
 * @param {object} args     parsed CLI args (read for allow-listed flags only)
 * @param {string} version  CLI version (from package.json)
 * @param {() => Promise<number>} run  the command handler
 */
export async function traceCommand(command, args, version, run) {
  let config;
  try {
    config = resolveTelemetryConfig();
  } catch {
    config = { enabled: false };
  }

  // Generate trace context BEFORE the export gate below, so outgoing REST/MCP
  // calls can forward it as `traceparent` even when telemetry is disabled.
  // Propagation is decoupled from export: a user with no OTLP endpoint (the
  // common case — TELEMETRY_TOKEN is empty in git) still gets a single
  // correlated server-side trace. The `sampled` bit is what reflects export.
  // The same IDs are reused in exportInvocation() to link the CLI span to
  // REST spans.
  _activeTraceId = randHex(16);
  _activeSpanId = randHex(8);
  _activeSampled = Boolean(config.enabled);

  // Fast path: no export configured → run with zero telemetry overhead. Still
  // normalize the result to a numeric exit code: commands may resolve to an
  // { exitCode, ...extra } object (e.g. `doctor`), and only the instrumented
  // path below unwraps it. Returning `run()` raw would leak that object all the
  // way to `process.exit(obj)` in the bin entry → ERR_INVALID_ARG_TYPE crash
  // (exit 1) for every user without an OTLP endpoint configured.
  if (!config.enabled) {
    try {
      return normalizeExitCode(await run());
    } finally {
      _activeTraceId = null;
      _activeSpanId = null;
      _activeSampled = false;
    }
  }

  const startMs = Date.now();
  let exitCode = 0;
  // `outcome` is the command's VERDICT (ok | failure | error); `status` is the
  // SPAN status, and only a crash sets it to error. See the note above the
  // non-zero-exit branch below.
  let outcome = 'ok';
  let status = 'ok';
  let statusMessage;
  let extraAttrs = {};
  try {
    const result = await run();
    // Commands may return either a plain exit code (number) or an object with
    // { exitCode, ...extra } — the latter lets commands surface bounded,
    // non-PII diagnostic fields (e.g. which checks failed in `doctor`).
    exitCode = normalizeExitCode(result);
    if (result !== null && typeof result === 'object') {
      const { exitCode: _ec, ...rest } = result;
      // Flatten any array-valued extras to a comma-joined string so they fit
      // the flat attribute bag shape (OTLP stringValue).
      for (const [k, v] of Object.entries(rest)) {
        extraAttrs[k] = Array.isArray(v) ? v.join(',') : v;
      }
    }
    if (typeof exitCode === 'number' && exitCode !== 0) {
      // A non-zero exit is a REPORTED VERDICT, not a fault: `doctor` exits 1
      // because a check it ran came back failing, and `lint` exits 1 because it
      // found what it was asked to look for. Both commands did their job. Only
      // a crash (the catch below) is an error, so `status` stays `'ok'` here —
      // which `buildTracePayload` emits as STATUS_CODE_OK (1), the same status
      // a zero-exit run gets — and the verdict is carried by
      // `lorekit.cli.outcome=failure` +
      // `lorekit.cli.exit_code` — which keeps the CLI's error rate a measure of
      // the CLI being broken rather than of the user's environment being
      // unhealthy. Query the failure verdicts on those attributes, never on the
      // span status.
      outcome = 'failure';
    }
    return exitCode;
  } catch (e) {
    outcome = 'error';
    status = 'error';
    // Record only a bounded, non-PII identifier — NEVER e.message. Node fs /
    // network error messages embed absolute paths (e.g. "ENOENT: ... open
    // '/home/me/proj/.mcp.json'"), which must never reach an exported span. The
    // error status code already conveys failure.
    statusMessage = errorLabel(e);
    exitCode = 1;
    throw e;
  } finally {
    // NOTE: on a thrown command error the `throw e` above is deferred until this
    // finally settles, so a crash still awaits `exportInvocation` (up to
    // timeoutMs, default 1500 ms) before propagating. This is intentional — the
    // in-flight span would otherwise be dropped on exit. Do not shorten the
    // timeout without weighing this "crash appears to hang ~1.5 s" trade-off.
    try {
      const attributes = commandAttributes({
        command,
        args,
        outcome,
        exitCode: typeof exitCode === 'number' ? exitCode : undefined,
        extraAttrs,
      });
      await exportInvocation(config, {
        version,
        name: `lorekit.cli.${command}`,
        attributes,
        startMs,
        endMs: Date.now(),
        status,
        statusMessage,
        traceId: _activeTraceId,
        spanId: _activeSpanId,
      });
    } catch {
      // never let telemetry break the CLI
    } finally {
      _activeTraceId = null;
      _activeSpanId = null;
      _activeSampled = false;
    }
  }
}
