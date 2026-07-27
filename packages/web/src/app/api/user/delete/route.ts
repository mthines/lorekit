import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';

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
 * Returns 200 on success, 401 if unauthenticated, 500 on server error.
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
  // runs in the Next.js server runtime.
  const serviceClient = createServiceClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['SUPABASE_SERVICE_ROLE_KEY']!,
  );

  // deleteUser cascades via ON DELETE CASCADE foreign keys to erase memories,
  // api_tokens, webhook_secrets, audit_log rows, and the auth.users row itself.
  const { error } = await serviceClient.auth.admin.deleteUser(user.id);

  if (error) {
    console.error('[delete-account] failed to delete user', user.id, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}