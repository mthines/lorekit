# openapi — OpenAPI spec + Swagger UI

Serves the LoreKit REST API specification and a browser-based exploration UI. No auth required — this is a public endpoint.

## URL patterns

| Method | Path | Response |
|--------|------|----------|
| GET | / | `application/json` — OpenAPI 3.1 spec |
| GET | /ui | `text/html` — Swagger UI page |

## Spec generation

The spec is **generated lazily on first request** and cached for the lifetime of the isolate:

```typescript
import { generateSpec } from '@lorekit/schemas/openapi/spec';

let cachedSpec: unknown;

function getSpec() {
  if (!cachedSpec) cachedSpec = generateSpec();
  return cachedSpec;
}
```

`generateSpec()` assembles the full OpenAPI 3.1 document from schema definitions registered in `packages/schemas/src/openapi/spec.ts`.

## Base URL

The `servers[0].url` in the generated spec is derived from the `SUPABASE_URL` environment variable:

```typescript
const baseUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1`;
```

## Swagger UI (`GET /ui`)

Returns an HTML page that:
1. Loads the Swagger UI assets from a CDN.
2. Points `url` at the same function's `/` endpoint so it fetches the live spec.

No separate hosting is needed — both routes are served by the same Edge Function.

## Updating the spec

To add or modify API documentation:

1. **Schema changes** — edit types/validators in `packages/schemas/src/`. Zod schemas auto-propagate to the spec via `@asteasolutions/zod-to-openapi` helpers.
2. **Route registration** — add `registry.registerPath(...)` calls in `packages/schemas/src/openapi/spec.ts`.
3. **Redeploy** — run `supabase functions deploy openapi` (or redeploy all functions). The cache is per-isolate, so a redeploy picks up all changes immediately.
