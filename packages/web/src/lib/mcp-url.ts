/**
 * The stable vanity URL for the MCP endpoint — proxied through lorekit.io by
 * the Next.js rewrite in next.config.ts. Use this in config snippets shown to
 * users so they get a permanent, readable URL that doesn't expose the raw
 * Supabase project ref.
 */
export const VANITY_MCP_URL = 'https://lorekit.io/v1/mcp';

/**
 * Resolve the user's MCP + webhook URLs from the Supabase project ref.
 * Shared by the dashboard onboarding and the settings pages so the derivation
 * lives in exactly one place.
 *
 * Returns both the raw Supabase URL (`mcpUrl`, for informational display) and
 * the vanity URL (`vanityMcpUrl`, for config snippets shown to users).
 */
export function resolveMcpUrls(): {
  mcpUrl: string;
  vanityMcpUrl: string;
  webhookUrl: string;
} {
  const supabaseUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '';
  const projectRef = supabaseUrl.replace('https://', '').replace('.supabase.co', '');
  const mcpUrl = projectRef
    ? `https://${projectRef}.supabase.co/functions/v1/mcp`
    : 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';
  return { mcpUrl, vanityMcpUrl: VANITY_MCP_URL, webhookUrl: `${mcpUrl}/webhooks/github` };
}
