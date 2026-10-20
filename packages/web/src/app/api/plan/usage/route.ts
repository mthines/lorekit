import { NextResponse } from 'next/server';
import { getPlanUsage } from '@/lib/plan';

/**
 * GET /api/plan/usage
 *
 * The caller's plan and active memory count — `getPlanUsage` over HTTP, for the
 * top bar's memory badge (`useMemoryTotal`). The badge used to call the server
 * action directly. Next's router runs server actions one at a time per client,
 * so on `/lore` it led a queue that the pending-invites read and the Explorer's
 * list waited behind on every load and every window focus. As a route handler
 * it is an ordinary request that runs in parallel and the browser can abort.
 *
 * Same contract as the action: `null` when there is no session or the RPC
 * fails, and the badge degrades to 0. Never cached, because the count moves
 * whenever an agent writes.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const usage = await getPlanUsage();
  return NextResponse.json(usage, { headers: { 'Cache-Control': 'no-store' } });
}
