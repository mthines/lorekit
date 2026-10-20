/**
 * `GET /api/plan/usage` and `GET /api/invites/pending` are transports, not new
 * logic: each wraps an existing server function so the browser can read it as
 * an ordinary, parallel, abortable request instead of a queued server action.
 * Pinned here: they answer exactly what the function returns (including its
 * signed-out / failure shape) and are never cached.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPlanUsage = vi.fn();
const listPendingInvitesForMe = vi.fn();

vi.mock('@/lib/plan', () => ({ getPlanUsage: () => getPlanUsage() }));
vi.mock('@/lib/org-invites', () => ({
  listPendingInvitesForMe: () => listPendingInvitesForMe(),
}));

const planUsageRoute = await import('./plan/usage/route');
const pendingInvitesRoute = await import('./invites/pending/route');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/plan/usage', () => {
  it('answers the caller plan usage as JSON, uncached', async () => {
    getPlanUsage.mockResolvedValue({ count: 3318, limit: 5000, plan: 'free' });

    const response = await planUsageRoute.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ count: 3318, limit: 5000, plan: 'free' });
  });

  it('answers null when there is no session or the RPC failed, as the action did', async () => {
    getPlanUsage.mockResolvedValue(null);

    const response = await planUsageRoute.GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });

  it('is rendered per request, never statically', () => {
    expect(planUsageRoute.dynamic).toBe('force-dynamic');
  });
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
