/** The hosted LoreKit MCP endpoint, used when no usable Supabase URL is configured. */
const HOSTED_MCP_URL = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';

/**
 * Normalise a Supabase base URL (`https://<ref>.supabase.co`, a self-hosted
 * custom domain, or a local `http://127.0.0.1:54321`) to `origin + path` with
 * no trailing slash. Returns `null` for anything that is not an absolute
 * http(s) URL, so the caller can fall back instead of emitting a broken URL.
 */
function supabaseBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Resolve the user's MCP + webhook URLs from NEXT_PUBLIC_SUPABASE_URL — any
 * Supabase base URL, not only `*.supabase.co`. Shared by the dashboard
 * onboarding and the settings pages so the derivation lives in exactly one place.
 */
export function resolveMcpUrls(): { mcpUrl: string; webhookUrl: string } {
  const base = supabaseBaseUrl(process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '');
  const mcpUrl = base ? `${base}/functions/v1/mcp` : HOSTED_MCP_URL;
  return { mcpUrl, webhookUrl: `${mcpUrl}/webhooks/github` };
}
