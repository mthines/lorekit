# MCP Server (Node.js / Fly.io)

`packages/mcp-server/` is the Node.js HTTP MCP server deployed on Fly.io. It is an
alternative to the self-contained Deno Edge Function in `supabase/functions/mcp/`, with
full OpenTelemetry SDK support.

## Role

- Runs on Fly.io (not Vercel / Supabase).
- Exposes the same `memory.*` MCP tools as the Deno Edge Function.
- Uses `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport`.
- Carries the full Node.js OTel SDK (traces + metrics + logs), unlike the edge function
  which uses the lightweight `_shared/otel.ts` helper.

## OTel instrumentation

`src/instrumentation.ts` MUST be the first import in `src/index.ts`. It initialises the
`NodeSDK` with `getNodeAutoInstrumentations()` from
`@opentelemetry/auto-instrumentations-node` v0.56.0+.

Key instrumentations enabled by default:

| Instrumentation | What it does |
|---|---|
| `instrumentation-http` | Creates server spans for every incoming HTTP request; extracts `traceparent` from the request headers and sets the active OTel span context. |
| `instrumentation-undici` | Patches Node 18+'s built-in `fetch` (undici-backed); injects the active OTel context as `traceparent` on every outgoing `fetch()` call. |

Disabled (noisy, not needed):

- `instrumentation-fs`
- `instrumentation-dns`

## W3C traceparent auto-propagation

**No manual plumbing is required in tool handlers.**

When a client (e.g. Agent0) sends a request with a `traceparent` header:

```
Client (traceparent header)
  → MCP server HTTP span   ← instrumentation-http extracts traceparent, sets active context
    → tool handler fetch() ← instrumentation-undici injects active context as traceparent
      → Supabase / REST API
```

The result is a **single trace** across Agent0 → MCP server → downstream service, visible
in Dash0 with no code changes in tool handlers.

This is verified by `src/otel-propagation.spec.ts`, which tests the `W3CTraceContextPropagator`
inject/extract round-trip directly (no SDK init required — uses `@opentelemetry/api` +
`@opentelemetry/core` only).

## Key env vars

| Var | Purpose |
|---|---|
| `OTEL_SERVICE_NAME` | Service name in Dash0 (default: `mcp`) |
| `OTEL_TRACES_EXPORTER` | Set to `otlp` to enable trace export |
| `OTEL_METRICS_EXPORTER` | Set to `otlp` to enable metric export |
| `OTEL_LOGS_EXPORTER` | Set to `otlp` to enable log export |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | e.g. `https://ingress.europe-west4.gcp.dash0-dev.com` |
| `OTEL_EXPORTER_OTLP_HEADERS` | e.g. `Authorization=Bearer <DASH0_AUTH_TOKEN>` |
| `OTEL_RESOURCE_ATTRIBUTES` | e.g. `deployment.environment.name=production` |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (CI / Fly.io) |
| `VCS_REPOSITORY_URL_FULL` | e.g. `https://github.com/mthines/lorekit` |
| `VCS_REF_HEAD_NAME` | Branch name (falls back to `GITHUB_REF_NAME`) |
| `VCS_REF_HEAD_REVISION` | Commit SHA (falls back to `GITHUB_SHA`) |

## Running locally

```bash
# From repo root
pnpm nx serve mcp-server

# Or directly
cd packages/mcp-server
pnpm dev
```

The server starts on port 3000 by default. Set `OTEL_*` env vars to send telemetry
to a local OTLP collector or Dash0.
