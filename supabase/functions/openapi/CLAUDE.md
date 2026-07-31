# openapi — OpenAPI spec

Serves the LoreKit REST API specification (machine-readable JSON). No auth
required — this is a public endpoint.

## URL patterns

| Method | Path | Response |
|--------|------|----------|
| GET | / | `application/json` — OpenAPI 3.1 spec |
| GET | /ui | `302` redirect → `https://lorekit.io/api-docs` (legacy path) |

## Where the rendered docs live

The browsable API reference is **NOT served here** — it lives in the Next.js
dashboard at **`https://lorekit.io/api-docs`** (rendered with Scalar,
`packages/web/src/app/api-docs/`). Supabase forcibly sandboxes any HTML served
from `*.supabase.co` (it rewrites `text/html` → `text/plain` and injects a
`default-src 'none'; sandbox` CSP), so an HTML UI page served from this function
could never render. The dashboard page fetches this function's spec through a
same-origin proxy (`/api-docs/spec`), so it works on localhost, preview, and
production without depending on this function's CORS allow-origin. The old
`GET /ui` route now 302-redirects to the dashboard page so existing bookmarks
keep working.

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

## Updating the spec

To add or modify API documentation:

1. **Schema changes** — edit types/validators in `packages/schemas/src/`. Zod schemas auto-propagate to the spec via `@asteasolutions/zod-to-openapi` helpers.
2. **Route registration** — add `registry.registerPath(...)` calls in `packages/schemas/src/openapi/spec.ts`.
3. **Redeploy** — run `supabase functions deploy openapi` (or redeploy all functions). The cache is per-isolate, so a redeploy picks up all changes immediately.
