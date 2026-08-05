/**
 * Test-run telemetry headers for the live smoke suites.
 *
 * The smoke specs are HTTP CLIENTS of the live edge functions (the `api`
 * service), so the server already emits a span for every call they make. What
 * was missing is a way to tell a deploy-pipeline smoke request apart from real
 * traffic in Dash0. These headers supply that:
 *
 *   • `X-LoreKit-Deployment-Environment` → the edge reports this request's
 *     `deployment.environment.name` (it honours only the synthetic `test`
 *     value; supabase/functions/_shared/otel.ts), so a whole smoke run's server
 *     spans sit under env=test alongside the CLI's own test-tagged spans.
 *   • `X-LoreKit-Correlation-Id`         → recorded on `usage_events.correlation_id`
 *     by the router, so ONE run's calls share a key.
 *
 * Both are read from the environment the deploy job sets (`DEPLOYMENT_ENVIRONMENT`,
 * `LOREKIT_CORRELATION_ID`) — the SAME vars the CLI's `restFetch` forwards — so
 * every smoke surface (CLI, REST, MCP) tags identically. Both are fail-safe:
 * unset/invalid ⇒ the header is omitted, so a local `vitest` run without the env
 * behaves exactly as before.
 *
 * Bounds mirror `normalizeRunEnvironment` / `normalizeCorrelationId` in the
 * zero-dep CLI (packages/cli/src/mcp.mjs); keep them in step.
 */
export function testRunHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = {};

  const rawEnv = env['DEPLOYMENT_ENVIRONMENT'] ?? env['OTEL_DEPLOYMENT_ENVIRONMENT'];
  if (typeof rawEnv === 'string') {
    const value = rawEnv.trim();
    if (value && value.length <= 64 && /^[A-Za-z0-9_.\-:]+$/.test(value)) {
      headers['X-LoreKit-Deployment-Environment'] = value;
    }
  }

  const rawCorrelation = env['LOREKIT_CORRELATION_ID'];
  if (typeof rawCorrelation === 'string') {
    const correlation = rawCorrelation.trim();
    if (correlation && correlation.length <= 200 && /^[A-Za-z0-9_\-./:#@]+$/.test(correlation)) {
      headers['X-LoreKit-Correlation-Id'] = correlation;
    }
  }

  return headers;
}
