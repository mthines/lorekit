// LoreKit CLI — self-contained OpenTelemetry export for command usage.
//
// The CLI is strictly zero-dependency (see packages/cli/package.json), so this
// mirrors the Edge Function's SDK-free approach (supabase/functions/_shared/
// otel.ts): OTLP/JSON over the global fetch (Node 18+), no @opentelemetry/*
// packages. One span + one counter data point per human-facing command
// (install / doctor / migrate), fired to Dash0 so the maintainers can see
// which commands people actually run.
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

// ── Baked-in defaults (public by design) ──────────────────────────────────────
// The endpoint is a committed default; the token is injected at publish time
// (empty in the source tree, so default export stays off until built/injected).
const DEFAULT_ENDPOINT = 'https://ingress.europe-west4.gcp.dash0-dev.com';
const DEFAULT_TOKEN = TELEMETRY_TOKEN; // injected from LOREKIT_TELEMETRY_TOKEN at publish
const DEFAULT_DATASET = 'lorekit-cli';

// Flags worth counting (e.g. how many installs are --global). Bounded on
// purpose: only these booleans are ever attached, never free-form values.
const FLAG_ATTRS = ['global', 'project', 'deep', 'yes', 'force', 'no-hooks'];

const OFF_VALUES = new Set(['0', 'off', 'false', 'no', 'disable', 'disabled']);

// ── Config resolution ─────────────────────────────────────────────────────────

/**
 * Resolve telemetry config from env + baked-in defaults.
 * Returns { enabled: false } when disabled or unconfigured, else the endpoint
 * and headers to export with.
 */
export function resolveTelemetryConfig(env = process.env) {
  const optOut = env.LOREKIT_TELEMETRY;
  if (optOut !== undefined && OFF_VALUES.has(String(optOut).trim().toLowerCase())) {
    return { enabled: false };
  }
  // DNT spec designates exactly `1` as the opt-out signal (consoledonottrack.com).
  // Match it precisely — a stray `DO_NOT_TRACK=false` should NOT disable export
  // (use LOREKIT_TELEMETRY for the loose app-specific opt-out values).
  if (env.DO_NOT_TRACK && String(env.DO_NOT_TRACK).trim() === '1') {
    return { enabled: false };
  }

  const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_ENDPOINT || '')
    .trim()
    .replace(/\/+$/, '');
  if (!endpoint) return { enabled: false };

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
    return { enabled: false };
  }

  const dataset = env.DASH0_DATASET || DEFAULT_DATASET;
  if (dataset) headers['Dash0-Dataset'] = dataset;

  return { enabled: true, endpoint, headers };
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

function resourceAttributes(version) {
  return [
    { key: 'service.name', value: { stringValue: 'lorekit-cli' } },
    { key: 'service.namespace', value: { stringValue: 'lorekit' } },
    { key: 'service.version', value: { stringValue: String(version) } },
    { key: 'process.runtime.name', value: { stringValue: 'nodejs' } },
    { key: 'process.runtime.version', value: { stringValue: process.versions.node } },
    { key: 'os.type', value: { stringValue: process.platform } },
    { key: 'host.arch', value: { stringValue: process.arch } },
  ];
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

export function buildTracePayload({ version, name, attributes, startMs, endMs, status, statusMessage }) {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(version) },
        scopeSpans: [
          {
            scope: { name: 'lorekit-cli', version: String(version) },
            spans: [
              {
                traceId: randHex(16),
                spanId: randHex(8),
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
            scope: { name: 'lorekit-cli', version: String(version) },
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
export async function exportInvocation(config, { version, name, attributes, startMs, endMs, status, statusMessage }, { timeoutMs = 1500 } = {}) {
  if (!config || !config.enabled) return;
  const trace = buildTracePayload({ version, name, attributes, startMs, endMs, status, statusMessage });
  const metric = buildMetricsPayload({ version, attributes, startMs, endMs });
  await Promise.all([
    post(`${config.endpoint}/v1/traces`, config.headers, trace, timeoutMs),
    post(`${config.endpoint}/v1/metrics`, config.headers, metric, timeoutMs),
  ]);
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
 * @param {string} command  bounded: install | doctor | migrate
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

  // Fast path: no export configured → run with zero telemetry overhead. Still
  // normalize the result to a numeric exit code: commands may resolve to an
  // { exitCode, ...extra } object (e.g. `doctor`), and only the instrumented
  // path below unwraps it. Returning `run()` raw would leak that object all the
  // way to `process.exit(obj)` in the bin entry → ERR_INVALID_ARG_TYPE crash
  // (exit 1) for every user without an OTLP endpoint configured.
  if (!config.enabled) return normalizeExitCode(await run());

  const startMs = Date.now();
  let exitCode = 0;
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
      status = 'error';
      statusMessage = `exit ${exitCode}`;
    }
    return exitCode;
  } catch (e) {
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
        outcome: status === 'error' ? 'error' : 'ok',
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
      });
    } catch {
      // never let telemetry break the CLI
    }
  }
}
