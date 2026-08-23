# Telemetry quality & cross-service correlation review

_Reviewed: 2026-07 · Scope: traces, metrics, and W3C context propagation across
`cli`, `api` (edge), `mcp-node`, and `web`._

This review answers two questions: **(1) is LoreKit's telemetry actually
generated correctly and correlated across services?** and **(2) does it meet
OTel semantic-convention and instrumentation best practices?** It was graded
against the Dash0 `otel-semantic-conventions` and `otel-instrumentation` skills.

Verdict: **the correlation architecture is sound and now regression-guarded by
tests.** One clear semantic-convention bug was found and fixed; the rest are
lower-severity recommendations.

---

## How correlation works (verified)

Every component propagates one W3C `traceparent` through a single pure seam:
`parseTraceparent` (receiver) and `formatTraceparent` (sender), which live in
`packages/mcp-core/src/telemetry/trace-context.ts` and are mirrored verbatim into every
edge function (`supabase/functions/_shared/telemetry/trace-context.ts`). The zero-dep CLI
re-implements the same header format in `packages/cli/src/telemetry/telemetry.mjs`.

```
agent ─traceparent→ mcp-node ─traceparent→ api (edge) ─→ Postgres
  cli ─traceparent→ api (edge)
  web ─traceparent→ api (edge)          (browser + server, via @vercel/otel)
```

- **CLI → api / MCP → api**: the receiver continues the inbound trace (same
  `trace_id`, fresh `span_id`, `parent_span_id` = caller's span) or, if the
  header is invalid, starts a **new root** rather than emitting a corrupt span.
- **Response echo**: the edge echoes its SERVER span back as a `traceparent`
  response header (`Access-Control-Expose-Headers: traceparent`) so the caller
  can link to it.
- **Sampled flag** is recorded (`flags`) and propagated but never gates export —
  export is AlwaysOn, sampling is deferred to the Dash0 pipeline.

### Tests added

| File | Proves |
|------|--------|
| `packages/mcp-core/src/telemetry/otel-correlation.spec.ts` | CLI→api and MCP→api join one trace with correct parent/child linkage; N REST calls become siblings under the command span; the echoed header points back at the server span; a 3-service chain preserves one `trace_id`; invalid inbound → fresh root; the sampled flag is data, not an export gate; the zero-dep CLI header — source-scanned from the shipped `getActiveTraceparent` — renders byte-identically to `formatTraceparent`. |
| `packages/mcp-core/src/telemetry/otel-conventions.spec.ts` | Drift guards: the three components declare **distinct** `service.name` values (`cli`/`api`/`web`); `service.namespace=lorekit` everywhere; edge span kinds SERVER(root)/CLIENT(db)/INTERNAL(child) with OTLP wire values; `faas.name` distinguishes the five edge functions; the edge (`extractTraceContext`/`withTraceparent`) and CLI (`getActiveTraceparent`) source keeps routing propagation through the shared `parseTraceparent`/`formatTraceparent` seam; export never branches on `sampled`; every tool span carries `lorekit.tool.name` and feeds the `lorekit.tool.duration` histogram with low-cardinality attributes. Plus unit coverage of the histogram accessor (name, memoization, no-throw record). |
| `packages/mcp-core/src/telemetry/otel-harness.spec.ts` | The correlated-trace harness's pure builder emits three service blocks (`cli`/`api`/`mcp-node`) under ONE `trace_id`, each resource stamped `deployment.environment.name=test`; correct span kinds; and the real parentage — CLI→api, MCP→api, and every DB CLIENT span under an api SERVER span — all off the CLI root. |
| `packages/cli/test/telemetry.test.mjs` (extended) | `os.type` / `host.arch` emit OTel-registry values, incl. `ppc`→`ppc32` (see bug below); `deployment.environment.name` is omitted by default and emitted only under an explicit `DEPLOYMENT_ENVIRONMENT` override. |

These complement the pre-existing suites: `trace-context.spec.ts` (strict W3C
parse/format), `edge-parity.spec.ts` (the CLI/edge mirror can't drift), and the
existing `telemetry.test.mjs` (config, opt-out, payload shape, PII posture).

---

## Emitting a real correlated trace to Dash0 (the harness)

The suites above run **offline** — they never boot an exporter, so nothing they
run reaches Dash0. That is correct for a fast CI, but it leaves no way to
**visually** confirm correlation in the backend. `scripts/telemetry/emit-correlated-trace.mts`
is the on-demand tool for exactly that: it emits **one** real, correlated
cross-service trace to Dash0 and prints its `trace_id`.

```bash
# Point it at Dash0 (any OTLP endpoint + auth works; env only, no committed secret):
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingress.europe-west4.gcp.dash0-dev.com
export OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer <ingesting-only-token>, Dash0-Dataset=lorekit-test'

pnpm emit-trace          # → node --experimental-transform-types scripts/telemetry/emit-correlated-trace.mts
```

It prints the emitted `trace_id`, the endpoint host, the dataset, and the
Dash0 filter to use. With no endpoint/token configured it **no-ops** with a
clear message (never crashes, never needs a secret in git).

**From CI (no local secret needed).** The `Emit correlated trace (manual)`
workflow (`.github/workflows/emit-trace.yml`) runs the same harness on demand
from the Actions tab (`workflow_dispatch`). It reuses the existing
`LOREKIT_TELEMETRY_TOKEN` secret (the one the release job bakes into the CLI
tarball), so the endpoint/auth are already wired — just click **Run workflow**.
Two optional inputs: `environment` (the `deployment.environment.name` tag,
default `test`) and `dataset` (blank → the token's default dataset). The
`trace_id` appears in the job log. The button only shows once the workflow file
is on the default branch.

**What it emits** — one trace covering all three production correlation paths:

```
cli (INTERNAL, service=cli)                       ← the CLI command span (root)
├─ api SERVER (POST /memories, service=api)        ← CLI → api
│   └─ api CLIENT (INSERT … memories)              ← multi-hop edge chain (server → db)
└─ mcp-node SERVER (tools/call, service=mcp-node)  ← the MCP hop
    └─ api SERVER (GET /memories, service=api)     ← MCP → api
        └─ api CLIENT (SELECT … memories)          ← multi-hop edge chain
```

**Why it is faithful, not a mock.** Each span is built with the component's own
emission code — the CLI's real `buildTracePayload`, the edge's real `Span` /
`buildOtlpPayload` (`supabase/functions/_shared/telemetry/otel.ts`) — and every parent→child
edge is derived through the **real** W3C seam (`formatTraceparent` →
`parseTraceparent`), exactly as the edge's `extractTraceContext` does on the
wire. It runs in Node via `--experimental-transform-types` and shims `Deno.env`
onto `process.env` so the edge code runs unmodified. (The `mcp-node` span is the
one approximation: the Node MCP server emits through the OTel SDK, which can't be
driven single-shot cross-package, so its span is produced by the same edge
builder with `service.name=mcp-node` — identical OTLP wire shape.)

### Isolating the `test` dataset in Dash0

Every span the harness emits carries `deployment.environment.name=test` as a
**global resource attribute** across all four service identities. This is the
existing semconv attribute (elsewhere `production` / `preview` / `development` /
`local`), so nothing new needs indexing — filter or route on it:

- **Filter**: in any Dash0 view, add `deployment.environment.name = test`, then
  open the printed `trace_id` to see the full waterfall.
- **Isolate**: send it to a dedicated dataset with a `Dash0-Dataset` header (see
  the `OTEL_EXPORTER_OTLP_HEADERS` above), and/or add a Dash0 routing rule keyed
  on `deployment.environment.name = test` so these traces never mix with
  production telemetry.

The marker is wired through **one env-driven path** every component honours:
`DEPLOYMENT_ENVIRONMENT` (the harness sets it to `test`). The edge's
`resolveDeploymentEnv()` and the CLI's `resolveDeploymentEnvironment()` both read
it first, ahead of the ambient `VERCEL_ENV` mapping; the Node `mcp-node` server
reaches the same value natively via `OTEL_RESOURCE_ATTRIBUTES`. The CLI otherwise
still omits the attribute by default (it has no ambient deployment).

---

## Bug fixed

**`os.type` / `host.arch` emitted Node spellings, not OTel-registry values**
(`packages/cli/src/telemetry/telemetry.mjs`). The CLI resource set `os.type` from
`process.platform` (`win32`, `sunos`) and `host.arch` from `process.arch`
(`x64`, `ia32`, `arm`). Those Node spellings are **not** members of the OTel
`os.type` / `host.arch` registries (`windows`, `solaris` / `amd64`, `x86`,
`arm32`), so a Dash0/OTel-native backend can't group them with telemetry from
other SDKs. Fixed with pure `normalizeOsType` / `normalizeHostArch` mappings
(canonical/unknown values pass through) plus tests. Low blast radius: CLI
resource attributes only.

---

## Recommendations (not applied — design/judgment calls)

1. **`db.query.text` and DB span names inline literal filter values**
   (`_shared/telemetry/otel.ts` `buildSql`). Span names like
   `SELECT ... FROM memories WHERE scope = 'repo::acme/x' AND key = '...'` are
   **high-cardinality** (an anti-pattern for span names, which should group) and
   put user-controlled values (scope, key, filter args) into `db.query.text`,
   which the semantic conventions define as the **parameterized/sanitized**
   statement. Recommend: name the span by operation + table
   (`SELECT memories`) and set `db.query.text` to the statement with
   placeholders (`... WHERE scope = $1 AND key = $2`), keeping literal values off
   the span. This is a deliberate design change to all edge DB spans, so it is
   left for maintainer sign-off rather than auto-applied.

2. **`error.message` is a non-registry attribute.** `Span.error()` /
   `clientError()` set `error.message`; the conventions use `exception.message`
   (with `exception.type`) or `error.type`. Also, PostgREST error strings placed
   there can carry incidental detail. Recommend migrating to `error.type` +
   `exception.message`, and confirming no user data reaches the message.

3. **Unhandled throws skip the response `traceparent` echo.** `traceRequest`'s
   `catch` path rethrows without `withTraceparent`, so a caller can't correlate a
   truly-thrown 500. Most handlers return error `Response`s (which are echoed),
   so impact is small; consider echoing on the throw path too.

4. **Successful spans set status `OK` explicitly.** The spec recommends leaving
   status `UNSET` for success unless there's a reason to assert `OK`. Cosmetic;
   consistent across CLI and edge, so low priority.

---

## What's already good

- One `service.namespace=lorekit`; distinct, documented `service.name` per
  component; the "five edge functions are one `api` service, told apart by
  `faas.name`" decision is correct and now guarded.
- Correct span kinds for service-map edges (SERVER/CLIENT), with the API-enum vs
  OTLP-wire kind values used correctly in each layer.
- Strong **no-PII posture** in CLI telemetry: bounded flag allow-list, bounded
  error labels (`err.code` / constructor name, never `err.message`), opt-out via
  `LOREKIT_TELEMETRY` / `DO_NOT_TRACK`.
- `lorekit.tool.duration` histogram uses unit `s` and low-cardinality dimensions
  (`lorekit.tool.name`, `lorekit.scope.type`); the CLI counter is a monotonic
  DELTA sum — both appropriate.
- Context propagation is **decoupled from export**: even a telemetry-disabled
  CLI still sends `traceparent` so server-side traces correlate.
