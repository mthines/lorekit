import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { handleGitHubWebhook } from './github.js';
import { write } from '@lorekit/core';

// Mock @lorekit/core write to avoid needing a real DB
vi.mock('@lorekit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lorekit/core')>();
  return {
    ...actual,
    createServiceClient: vi.fn(() => ({})),
    write: vi.fn().mockResolvedValue({ id: 'mock-id', created_at: new Date().toISOString() }),
  };
});

const WEBHOOK_SECRET = 'test-secret';

function makeSignedRequest(event: string, body: string): Request {
  const sig = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
  return new Request('http://localhost/webhooks/github', {
    method: 'POST',
    headers: {
      'x-github-event': event,
      'x-hub-signature-256': sig,
      'content-type': 'application/json',
    },
    body,
  });
}

describe('handleGitHubWebhook', () => {
  beforeEach(() => {
    process.env['GITHUB_WEBHOOK_SECRET'] = WEBHOOK_SECRET;
    process.env['SUPABASE_URL'] = 'http://localhost:54321';
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-role-key';
  });

  it('returns 401 for invalid HMAC signature', async () => {
    const body = JSON.stringify({ action: 'created' });
    const req = new Request('http://localhost/webhooks/github', {
      method: 'POST',
      headers: { 'x-github-event': 'pull_request_review_comment', 'x-hub-signature-256': 'sha256=invalid' },
      body,
    });
    const res = await handleGitHubWebhook(req);
    expect(res.status).toBe(401);
  });

  it('creates a memory entry tagged source::pr-webhook for PR comment event', async () => {
    const payload = {
      action: 'created',
      repository: { full_name: 'mthines/gw-tools' },
      comment: {
        body: 'Always use worktree isolation for branch-scoped changes',
        html_url: 'https://github.com/mthines/gw-tools/pull/1#comment-1',
      },
    };
    const body = JSON.stringify(payload);
    const req = makeSignedRequest('pull_request_review_comment', body);
    const res = await handleGitHubWebhook(req);

    expect(res.status).toBe(200);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'repo::mthines/gw-tools',
        value: 'Always use worktree isolation for branch-scoped changes',
        tags: expect.arrayContaining(['source::pr-webhook']),
      }),
    );
  });

  it('skips and returns 200 for empty comment body', async () => {
    vi.clearAllMocks();
    const payload = {
      action: 'created',
      repository: { full_name: 'mthines/gw-tools' },
      comment: { body: '   ', html_url: 'https://github.com' },
    };
    const body = JSON.stringify(payload);
    const req = makeSignedRequest('pull_request_review_comment', body);
    const res = await handleGitHubWebhook(req);

    expect(res.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });

  it('creates a memory entry for pull_request_review event', async () => {
    vi.clearAllMocks();
    const payload = {
      action: 'submitted',
      repository: { full_name: 'mthines/gw-tools' },
      review: {
        body: 'Consider extracting this into a shared helper',
        html_url: 'https://github.com/mthines/gw-tools/pull/2#pullrequestreview-1',
      },
    };
    const body = JSON.stringify(payload);
    const req = makeSignedRequest('pull_request_review', body);
    const res = await handleGitHubWebhook(req);

    expect(res.status).toBe(200);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'repo::mthines/gw-tools',
        value: 'Consider extracting this into a shared helper',
        tags: expect.arrayContaining(['source::pr-webhook', 'event::pull_request_review']),
      }),
    );
  });

  it('skips pull_request_review with an empty review body', async () => {
    vi.clearAllMocks();
    const payload = {
      action: 'submitted',
      repository: { full_name: 'mthines/gw-tools' },
      review: { body: '', html_url: 'https://github.com/mthines/gw-tools/pull/2#review-1' },
    };
    const body = JSON.stringify(payload);
    const req = makeSignedRequest('pull_request_review', body);
    const res = await handleGitHubWebhook(req);

    expect(res.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });

  it('returns 200 and skips write when payload has no repository field', async () => {
    vi.clearAllMocks();
    const payload = { action: 'created', comment: { body: 'x', html_url: 'https://github.com' } };
    const body = JSON.stringify(payload);
    const req = makeSignedRequest('pull_request_review_comment', body);
    const res = await handleGitHubWebhook(req);

    expect(res.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });

  it('returns 200 and skips write for an unhandled event type', async () => {
    vi.clearAllMocks();
    const payload = {
      action: 'labeled',
      repository: { full_name: 'mthines/gw-tools' },
    };
    const body = JSON.stringify(payload);
    const req = makeSignedRequest('issues', body);
    const res = await handleGitHubWebhook(req);

    expect(res.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });
});
