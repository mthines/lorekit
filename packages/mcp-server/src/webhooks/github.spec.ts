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
    vi.clearAllMocks();
  });

  // ── Authentication ──────────────────────────────────────────────────────────

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

  // ── Action-tier gate (AC-1, AC-5) ──────────────────────────────────────────

  it('AC-1: skips pull_request_review_comment with action edited (not created)', async () => {
    const payload = {
      action: 'edited',
      repository: { full_name: 'mthines/gw-tools' },
      comment: {
        body: 'Always use worktree isolation for branch-scoped changes to avoid state bleed.',
        html_url: 'https://github.com/mthines/gw-tools/pull/1#comment-1',
      },
    };
    const res = await handleGitHubWebhook(makeSignedRequest('pull_request_review_comment', JSON.stringify(payload)));
    expect(res.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });

  it('AC-5: skips pull_request_review with action dismissed (not submitted)', async () => {
    const payload = {
      action: 'dismissed',
      repository: { full_name: 'mthines/gw-tools' },
      review: {
        body: 'Looks good to me after the last round of changes.',
        html_url: 'https://github.com/mthines/gw-tools/pull/2#review-1',
      },
    };
    const res = await handleGitHubWebhook(makeSignedRequest('pull_request_review', JSON.stringify(payload)));
    expect(res.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });

  // ── Signal-quality gate (AC-2, AC-3) ───────────────────────────────────────

  it('AC-2: skips pull_request_review_comment with body shorter than 20 chars', async () => {
    const payload = {
      action: 'created',
      repository: { full_name: 'mthines/gw-tools' },
      comment: { body: 'ok', html_url: 'https://github.com/mthines/gw-tools/pull/1#comment-1' },
    };
    const res = await handleGitHubWebhook(makeSignedRequest('pull_request_review_comment', JSON.stringify(payload)));
    expect(res.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });

  it('AC-3: skips pull_request_review_comment with bot-noise body', async () => {
    const payload = {
      action: 'created',
      repository: { full_name: 'mthines/gw-tools' },
      comment: {
        body: 'Build passed ✓ — all 12 checks passed',
        html_url: 'https://github.com/mthines/gw-tools/pull/1#comment-2',
      },
    };
    const res = await handleGitHubWebhook(makeSignedRequest('pull_request_review_comment', JSON.stringify(payload)));
    expect(res.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });

  // ── Resolved thread fast path (AC-4) ───────────────────────────────────────

  it('AC-4: writes memory tagged signal::resolved-thread for pull_request_review_thread resolved', async () => {
    const payload = {
      action: 'resolved',
      repository: { full_name: 'mthines/gw-tools' },
      thread: {
        comments: [
          {
            body: 'Always use worktree isolation for branch-scoped changes to avoid state bleed across sessions.',
            html_url: 'https://github.com/mthines/gw-tools/pull/1#discussion_r1',
          },
        ],
      },
    };
    const res = await handleGitHubWebhook(
      makeSignedRequest('pull_request_review_thread', JSON.stringify(payload)),
    );
    expect(res.status).toBe(200);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'repo::mthines/gw-tools',
        value: 'Always use worktree isolation for branch-scoped changes to avoid state bleed across sessions.',
        ttl_days: 30,
        tags: expect.arrayContaining(['source::pr-webhook', 'signal::resolved-thread']),
      }),
    );
  });

  // ── TTL on all writes (AC-6) ────────────────────────────────────────────────

  it('AC-6: includes ttl_days: 30 on all qualifying writes', async () => {
    const payload = {
      action: 'created',
      repository: { full_name: 'mthines/gw-tools' },
      comment: {
        body: 'Always use worktree isolation for branch-scoped changes to avoid state bleed.',
        html_url: 'https://github.com/mthines/gw-tools/pull/1#comment-1',
      },
    };
    const res = await handleGitHubWebhook(
      makeSignedRequest('pull_request_review_comment', JSON.stringify(payload)),
    );
    expect(res.status).toBe(200);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ttl_days: 30 }),
    );
  });

  // ── Existing behaviour preserved ────────────────────────────────────────────

  it('creates a memory entry tagged source::pr-webhook for PR comment event', async () => {
    const payload = {
      action: 'created',
      repository: { full_name: 'mthines/gw-tools' },
      comment: {
        body: 'Always use worktree isolation for branch-scoped changes to avoid state bleed.',
        html_url: 'https://github.com/mthines/gw-tools/pull/1#comment-1',
      },
    };
    const res = await handleGitHubWebhook(makeSignedRequest('pull_request_review_comment', JSON.stringify(payload)));
    expect(res.status).toBe(200);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'repo::mthines/gw-tools',
        value: 'Always use worktree isolation for branch-scoped changes to avoid state bleed.',
        tags: expect.arrayContaining(['source::pr-webhook']),
      }),
    );
  });

  it('skips and returns 200 for empty comment body', async () => {
    const payload = {
      action: 'created',
      repository: { full_name: 'mthines/gw-tools' },
      comment: { body: '   ', html_url: 'https://github.com' },
    };
    const res = await handleGitHubWebhook(makeSignedRequest('pull_request_review_comment', JSON.stringify(payload)));
    expect(res.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });

  it('creates a memory entry for pull_request_review submitted', async () => {
    const payload = {
      action: 'submitted',
      repository: { full_name: 'mthines/gw-tools' },
      review: {
        body: 'Consider extracting this into a shared helper across packages.',
        html_url: 'https://github.com/mthines/gw-tools/pull/2#pullrequestreview-1',
      },
    };
    const res = await handleGitHubWebhook(makeSignedRequest('pull_request_review', JSON.stringify(payload)));
    expect(res.status).toBe(200);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'repo::mthines/gw-tools',
        value: 'Consider extracting this into a shared helper across packages.',
        tags: expect.arrayContaining(['source::pr-webhook', 'event::pull_request_review']),
      }),
    );
  });

  it('skips pull_request_review with an empty review body', async () => {
    const payload = {
      action: 'submitted',
      repository: { full_name: 'mthines/gw-tools' },
      review: { body: '', html_url: 'https://github.com/mthines/gw-tools/pull/2#review-1' },
    };
    const res = await handleGitHubWebhook(makeSignedRequest('pull_request_review', JSON.stringify(payload)));
    expect(res.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });

  it('returns 200 and skips write when payload has no repository field', async () => {
    const payload = { action: 'created', comment: { body: 'x', html_url: 'https://github.com' } };
    const res = await handleGitHubWebhook(makeSignedRequest('pull_request_review_comment', JSON.stringify(payload)));
    expect(res.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });

  it('returns 200 and skips write for an unhandled event type', async () => {
    const payload = { action: 'labeled', repository: { full_name: 'mthines/gw-tools' } };
    const res = await handleGitHubWebhook(makeSignedRequest('issues', JSON.stringify(payload)));
    expect(res.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });

  it('creates a memory entry for issue_comment created', async () => {
    const payload = {
      action: 'created',
      repository: { full_name: 'mthines/gw-tools' },
      comment: {
        body: 'The bug is reproducible when the worktree path contains a space character.',
        html_url: 'https://github.com/mthines/gw-tools/issues/5#issuecomment-1',
      },
    };
    const res = await handleGitHubWebhook(makeSignedRequest('issue_comment', JSON.stringify(payload)));
    expect(res.status).toBe(200);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'repo::mthines/gw-tools',
        tags: expect.arrayContaining(['event::issue_comment']),
      }),
    );
  });
});
