import { NextResponse } from 'next/server';
import { listPendingInvitesForMe } from '@/lib/org-invites';

/**
 * GET /api/invites/pending
 *
 * Pending org invites addressed to the caller — `listPendingInvitesForMe` over
 * HTTP, for the shared `['pending-invites']` query behind the top bar's invites
 * badge, the `/lore` banner and the Organization nav badge. Those used to call
 * the server action directly. Next's router runs server actions one at a time
 * per client, so on `/lore` this read sat in a queue with the plan-usage read
 * and the Explorer's list on every load and every window focus. As a route
 * handler it is an ordinary request that runs in parallel and the browser can
 * abort.
 *
 * Same contract as the action: `[]` when there is no session or the query
 * fails. Never cached: accepting or declining elsewhere must show up on the
 * next refetch.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const invites = await listPendingInvitesForMe();
  return NextResponse.json(invites, { headers: { 'Cache-Control': 'no-store' } });
}
