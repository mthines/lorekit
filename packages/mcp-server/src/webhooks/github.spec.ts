import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { handleGitHubWebhook } from './github.js';
import { deleteMemory, webhookTtlDays, write } from '@lorekit/core';
import { classifyWebhookAction } from './signal-filter.js';

// Mock @lorekit/core write to avoid needing a real DB
vi.mock('@lorekit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lorekit/core')>();
  return {
    ...actual,
    createServiceClient: vi.fn(() => makeDbStub()),
    write: vi.fn().mockResolvedValue({ id: 'mock-id', created_at: new Date().toISOString() }),
    deleteMemory: vi.fn().mockResolvedValue({ deleted: false, archived: true }),
  };
});

// The installation row the github_installations lookup resolves to. Mutated per
// test; `null` models "no linked row" (a pending install, or none at all).
let installationRow: { user_id: string | null } | null = { user_id: 'owner-uuid' };
let installationError: { message: string } | null = null;

// Minimal chainable stand-in for the one query handlePrStatePurge makes:
// .from(...).select(...).eq(...).eq(...).maybeSingle()
function makeDbStub() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: installationRow, error: installationError }),
  };
  return { from: () => chain };
}

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
        ttl_days: 90,
        tags: expect.arrayContaining(['source::pr-webhook', 'signal::resolved-thread']),
      }),
    );
  });

  // ── TTL on all writes, graded by signal tier (AC-6) ─────────────────────────

  // One payload shape per accepted (event, action) pair, with the retention the
  // tier earns. Asserted end-to-end through the real handler — the TTL is read
  // off the actual `write` call, not re-derived from webhookTtlDays, so a wiring
  // regression (right resolver, never called) still fails.
  const TIERED: ReadonlyArray<{
    label: string;
    event: string;
    payload: Record<string, unknown>;
    ttlDays: number;
  }> = [
    {
      label: 'resolved review thread (high)',
      event: 'pull_request_review_thread',
      ttlDays: 90,
      payload: {
        action: 'resolved',
        repository: { full_name: 'mthines/gw-tools' },
        thread: {
          comments: [
            {
              body: 'Always use worktree isolation for branch-scoped changes to avoid state bleed.',
              html_url: 'https://github.com/mthines/gw-tools/pull/1#discussion_r1',
            },
          ],
        },
      },
    },
    {
      label: 'submitted review (medium)',
      event: 'pull_request_review',
      ttlDays: 30,
      payload: {
        action: 'submitted',
        repository: { full_name: 'mthines/gw-tools' },
        review: {
          body: 'Consider extracting this into a shared helper across packages.',
          html_url: 'https://github.com/mthines/gw-tools/pull/2#pullrequestreview-1',
        },
      },
    },
    {
      label: 'created review comment (low)',
      event: 'pull_request_review_comment',
      ttlDays: 14,
      payload: {
        action: 'created',
        repository: { full_name: 'mthines/gw-tools' },
        comment: {
          body: 'Always use worktree isolation for branch-scoped changes to avoid state bleed.',
          html_url: 'https://github.com/mthines/gw-tools/pull/1#comment-1',
        },
      },
    },
    {
      label: 'created issue comment (low)',
      event: 'issue_comment',
      ttlDays: 14,
      payload: {
        action: 'created',
        repository: { full_name: 'mthines/gw-tools' },
        comment: {
          body: 'Remember to run the migration order check before pushing a new migration.',
          html_url: 'https://github.com/mthines/gw-tools/issues/3#issuecomment-1',
        },
      },
    },
  ];

  it.each(TIERED)('AC-6: $label writes ttl_days: $ttlDays', async ({ event, payload, ttlDays }) => {
    const res = await handleGitHubWebhook(makeSignedRequest(event, JSON.stringify(payload)));
    expect(res.status).toBe(200);
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ttl_days: ttlDays }),
    );
  });

  it('AC-6: every action the gate accepts is covered by a tier fixture', () => {
    // Guards the `low` fallback in webhookSignalTier from becoming the silent
    // default for a newly accepted event: if signal-filter grows a WRITE pair,
    // this fails until the pair is graded and given a fixture above.
    const covered = new Set(
      TIERED.map(({ event, payload }) => `${event}.${payload['action'] as string}`),
    );
    const accepted = [
      ['pull_request_review_thread', 'resolved'],
      ['pull_request_review', 'submitted'],
      ['pull_request_review_comment', 'created'],
      ['issue_comment', 'created'],
      // Pairs the gate rejects — present so this list is the full cross-product
      // of interest, not a copy of the fixture list.
      ['pull_request_review_comment', 'edited'],
      ['pull_request_review', 'dismissed'],
    ] as const;

    for (const [event, action] of accepted) {
      if (classifyWebhookAction(event, action) !== 'WRITE') continue;
      expect(covered).toContain(`${event}.${action}`);
      expect(webhookTtlDays(event, action)).toBe(
        TIERED.find((t) => t.event === event)?.ttlDays,
      );
    }
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

  // ── pull_request closed → per-PR state purge ───────────────────────────────
  //
  // The purge is an accelerant on pr-reviewer's 7-day TTL, not a mechanism
  // anything depends on, so every one of these asserts a 200 as well: a purge
  // that cannot happen must never turn a delivery into a retryable failure.

  describe('pull_request closed', () => {
    const mergedPayload = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        action: 'closed',
        repository: { full_name: 'mthines/agent-skills' },
        pull_request: { number: 123, merged: true, head: { ref: 'feat/x' } },
        installation: { id: 42 },
        ...over,
      });

    beforeEach(() => {
      installationRow = { user_id: 'owner-uuid' };
      installationError = null;
    });

    it('archives the PR-state record, attributed to the installation owner', async () => {
      const res = await handleGitHubWebhook(makeSignedRequest('pull_request', mergedPayload()));
      expect(res.status).toBe(200);
      expect(deleteMemory).toHaveBeenCalledTimes(1);
      // The third argument is load-bearing: deleteMemory only filters on user_id
      // when one is passed, so a null there would archive every account's record
      // at the same (scope, key).
      expect(deleteMemory).toHaveBeenCalledWith(
        expect.anything(),
        { scope: 'branch::mthines/agent-skills::feat/x', key: 'ci-state::pr-review-123', force: false },
        'owner-uuid',
      );
    });

    it('never writes a memory for a close', async () => {
      await handleGitHubWebhook(makeSignedRequest('pull_request', mergedPayload()));
      expect(write).not.toHaveBeenCalled();
    });

    it('soft-archives rather than hard-deleting', async () => {
      await handleGitHubWebhook(makeSignedRequest('pull_request', mergedPayload()));
      expect(deleteMemory).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ force: false }),
        expect.anything(),
      );
    });

    it('does nothing for a close without a merge', async () => {
      const res = await handleGitHubWebhook(
        makeSignedRequest('pull_request', mergedPayload({
          pull_request: { number: 123, merged: false, head: { ref: 'feat/x' } },
        })),
      );
      expect(res.status).toBe(200);
      expect(deleteMemory).not.toHaveBeenCalled();
    });

    it('does nothing when the delivery carries no installation', async () => {
      const res = await handleGitHubWebhook(
        makeSignedRequest('pull_request', mergedPayload({ installation: undefined })),
      );
      expect(res.status).toBe(200);
      expect(deleteMemory).not.toHaveBeenCalled();
    });

    it('does nothing when the installation is not linked to a user', async () => {
      installationRow = { user_id: null };
      const res = await handleGitHubWebhook(makeSignedRequest('pull_request', mergedPayload()));
      expect(res.status).toBe(200);
      expect(deleteMemory).not.toHaveBeenCalled();
    });

    it('does nothing when there is no installation row at all', async () => {
      installationRow = null;
      const res = await handleGitHubWebhook(makeSignedRequest('pull_request', mergedPayload()));
      expect(res.status).toBe(200);
      expect(deleteMemory).not.toHaveBeenCalled();
    });

    it('does nothing when the installation lookup errors', async () => {
      installationError = { message: 'connection reset' };
      const res = await handleGitHubWebhook(makeSignedRequest('pull_request', mergedPayload()));
      expect(res.status).toBe(200);
      expect(deleteMemory).not.toHaveBeenCalled();
    });

    it('returns 200 even when the archive itself throws', async () => {
      vi.mocked(deleteMemory).mockRejectedValueOnce(new Error('db exploded'));
      const res = await handleGitHubWebhook(makeSignedRequest('pull_request', mergedPayload()));
      expect(res.status).toBe(200);
    });

    it('ignores non-closed pull_request actions', async () => {
      for (const action of ['opened', 'synchronize', 'reopened']) {
        vi.clearAllMocks();
        const res = await handleGitHubWebhook(
          makeSignedRequest('pull_request', mergedPayload({ action })),
        );
        expect(res.status).toBe(200);
        expect(deleteMemory).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
      }
    });
  });
});
