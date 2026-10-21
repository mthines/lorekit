/**
 * `GET /api/invites/pending` is a transport, not new logic: it wraps the
 * existing server function so the browser can read it as an ordinary, parallel,
 * abortable request instead of a queued server action. Pinned here: it answers
 * exactly what the function returns (including its signed-out / failure shape)
 * and is never cached. (Plan usage started here too and has since moved to the
 * `GET /memories/quota` edge route.)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listPendingInvitesForMe = vi.fn();

vi.mock('@/lib/org-invites', () => ({
  listPendingInvitesForMe: () => listPendingInvitesForMe(),
}));

const pendingInvitesRoute = await import('./invites/pending/route');

beforeEach(() => {
  vi.clearAllMocks();
});
describe('GET /api/invites/pending', () => {
  it('answers the invites addressed to the caller as JSON, uncached', async () => {
    const invites = [{ id: 'inv-1', org_id: 'org-1', status: 'pending', org: { name: 'Acme', slug: 'acme' } }];
    listPendingInvitesForMe.mockResolvedValue(invites);

    const response = await pendingInvitesRoute.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual(invites);
  });

  it('answers [] when there is no session or the query failed, as the action did', async () => {
    listPendingInvitesForMe.mockResolvedValue([]);

    await expect((await pendingInvitesRoute.GET()).json()).resolves.toEqual([]);
  });

  it('is rendered per request, never statically', () => {
    expect(pendingInvitesRoute.dynamic).toBe('force-dynamic');
  });
});
