/**
 * Resolve the user's MCP + webhook URLs from the Supabase project ref.
 * Shared by the dashboard onboarding, the settings pages and the OAuth
 * protected-resource document so the derivation lives in exactly one place.
 */

/** The hosted production MCP endpoint — the fallback when no env is set. */
export const PRODUCTION_MCP_URL =
  'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';

export function resolveMcpUrls(): { mcpUrl: string; webhookUrl: string } {
  const mcpUrl = resolveMcpUrl();
  return { mcpUrl, webhookUrl: `${mcpUrl}/webhooks/github` };
}

/**
 * The MCP endpoint this deployment talks to.
 *
 * Hosted Supabase projects are `https://<ref>.supabase.co`, and the ref is all
 * we need. But `NEXT_PUBLIC_SUPABASE_URL` is also a plain origin during local
 * development (`http://127.0.0.1:54321`) and for a self-hosted deployment, and
 * the old ref-splitting produced a nonsense URL for those
 * (`https://http://127.0.0.1:54321.supabase.co/...`). That was invisible while
 * this only fed copy-paste onboarding snippets; it stops being invisible now
 * that the OAuth protected-resource document names this URL as its `resource`
 * and clients compare it against the server they are talking to.
 *
 * So: parse the origin, use the ref form when it IS a supabase.co host, and
 * otherwise append the function path to whatever origin we were given.
 */
export function resolveMcpUrl(): string {
  const raw = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '';
  if (!raw) return PRODUCTION_MCP_URL;

  try {
    return `${new URL(raw).origin}/functions/v1/mcp`;
  } catch {
    // Not a URL. A bare project ref has always been accepted here, so keep
    // expanding it rather than silently falling back to production and
    // pointing a self-hosted deployment at someone else's server.
    return /^[a-z0-9-]+$/i.test(raw)
      ? `https://${raw}.supabase.co/functions/v1/mcp`
      : PRODUCTION_MCP_URL;
  }
}
