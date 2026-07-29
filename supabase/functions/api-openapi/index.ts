import { traceRequest } from '../_shared/otel.ts';
import { corsHeaders, handlePreflight } from '../_shared/api/cors.ts';
import { internalError } from '../_shared/api/respond.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://pqokxlhvnosogizsjztg.supabase.co';
const BASE_URL = `${SUPABASE_URL}/functions/v1`;

let _spec: Record<string, unknown> | null = null;

async function getSpec(): Promise<Record<string, unknown>> {
  if (_spec) return _spec;
  const { generateSpec } = await import('@lorekit/schemas/openapi/spec');
  _spec = generateSpec(BASE_URL);
  return _spec;
}

const SWAGGER_HTML = (specUrl: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LoreKit REST API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
  <script>
    SwaggerUIBundle({ url: "${specUrl}", dom_id: '#swagger-ui', presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset], layout: 'BaseLayout', tryItOutEnabled: false });
  </script>
</body>
</html>`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handlePreflight(req);
  const cors = corsHeaders(req);
  const url = new URL(req.url);

  return traceRequest(req, 'lorekit.api-openapi', async (span) => {
    span.setAttributes({ 'lorekit.function': 'api-openapi' });

    if (url.pathname.endsWith('/ui')) {
      const specUrl = url.href.replace(/\/ui$/, '');
      return new Response(SWAGGER_HTML(specUrl), {
        headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' unpkg.com; style-src 'self' 'unsafe-inline' unpkg.com", ...cors },
      });
    }

    try {
      const spec = await getSpec();
      return new Response(JSON.stringify(spec), { headers: { 'Content-Type': 'application/json', ...cors } });
    } catch (e) {
      span.error(`spec generation failed: ${(e as Error).message}`);
      return internalError(cors);
    }
  });
});
