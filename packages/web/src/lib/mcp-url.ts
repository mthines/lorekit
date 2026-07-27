/**
 * Resolve the user's MCP + webhook URLs from the Supabase project ref.
 * Shared by the dashboard onboarding and the settings pages so the derivation
 * lives in exactly one place.
 */
export function resolveMcpUrls(): { mcpUrl: string; webhookUrl: string } {
  const supabaseUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '';
  const projectRef = supabaseUrl.replace('https://', '').replace('.supabase.co', '');
  const mcpUrl = projectRef
    ? `https://${projectRef}.supabase.co/functions/v1/mcp`
    : 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';
  return { mcpUrl, webhookUrl: `${mcpUrl}/webhooks/github` };
}
