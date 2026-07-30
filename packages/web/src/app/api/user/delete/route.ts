import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { createAdminClient, SupabaseAdminConfigError } from '@/lib/supabase/admin';

/**
 * DELETE /api/user/delete
 *
 * Permanently deletes the authenticated user and all of their data.
 *
 * Requires an active Supabase session (cookie-based). Uses a service-role
 * client to call auth.admin.deleteUser(), which cascades via DB foreign keys
 * to remove memories, api_tokens, webhook_secrets, audit_log rows, and the
 * auth.users row itself.
 *
 * Returns 200 on success, 401 if unauthenticated, 503 if the server is missing
 * SUPABASE_SERVICE_ROLE_KEY, 500 on any other server error.
 */
export async function DELETE() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Build a service-role client so we can call the admin API.
  // The service-role key is never exposed to the browser — this route only
  // runs in the Next.js server runtime. When the deployment is missing the
  // key, answer 503 naming the misconfiguration instead of letting
  // supabase-js throw the opaque `supabaseKey is required.` as a bare 500.
  let serviceClient;
  try {
    serviceClient = createAdminClient();
  } catch (error) {
    if (error instanceof SupabaseAdminConfigError) {
      console.error('[delete-account] server misconfigured', error.missingEnv);
      return NextResponse.json(
        {
          error: 'Account deletion is temporarily unavailable — the server is misconfigured.',
          code: error.code,
        },
        { status: 503 },
      );
    }
    throw error;
  }

  // deleteUser cascades via ON DELETE CASCADE foreign keys to erase memories,
  // api_tokens, webhook_secrets, audit_log rows, and the auth.users row itself.
  const { error } = await serviceClient.auth.admin.deleteUser(user.id);

  if (error) {
    console.error('[delete-account] failed to delete user', user.id, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
