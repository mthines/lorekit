import { traceRequest } from '../_shared/otel.ts';
import { corsHeaders, handlePreflight } from '../_shared/api/cors.ts';
import { internalError } from '../_shared/api/respond.ts';
import { generateSpec } from '../_shared/schemas/openapi/spec.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://pqokxlhvnosogizsjztg.supabase.co';
const BASE_URL = `${SUPABASE_URL}/functions/v1`;

// Canonical human-facing docs. The rendered API reference lives in the Next.js
// dashboard (Scalar), NOT here: Supabase forcibly sandboxes any HTML served
// from `*.supabase.co` (rewrites `text/html` → `text/plain` + injects a
// `default-src 'none'; sandbox` CSP), so an HTML page served from this function
// can never render. This function serves ONLY the machine-readable spec.
const DOCS_URL = 'https://lorekit.io/api-docs';

let _spec: Record<string, unknown> | null = null;

function getSpec(): Record<string, unknown> {
  if (!_spec) _spec = generateSpec(BASE_URL);
  return _spec;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handlePreflight(req);
  const cors = corsHeaders(req);
  const url = new URL(req.url);

  return traceRequest(req, 'lorekit.openapi', async (span) => {
    span.setAttributes({ 'lorekit.function': 'openapi' });

    // Legacy `/ui` route: the Swagger UI page used to be served here but could
    // never render (see DOCS_URL note). Redirect to the real docs so old
    // bookmarks keep working. A 302 has no HTML body, so the sandbox is moot.
    if (url.pathname.endsWith('/ui')) {
      return new Response(null, { status: 302, headers: { Location: DOCS_URL, ...cors } });
    }

    try {
      const spec = getSpec();
      return new Response(JSON.stringify(spec), { headers: { 'Content-Type': 'application/json', ...cors } });
    } catch (e) {
      span.error(`spec generation failed: ${(e as Error).message}`);
      return internalError(cors);
    }
  });
});
