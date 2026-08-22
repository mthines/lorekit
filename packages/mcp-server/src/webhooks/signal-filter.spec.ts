import { describe, it, expect } from 'vitest';
import { classifyWebhookAction, isSignalWorthy, prStatePurgeTarget } from './signal-filter.js';

// ── classifyWebhookAction ─────────────────────────────────────────────────────

describe('classifyWebhookAction', () => {
  describe('WRITE tiers', () => {
    it('pull_request_review_thread resolved → WRITE', () => {
      expect(classifyWebhookAction('pull_request_review_thread', 'resolved')).toBe('WRITE');
    });

    it('pull_request_review submitted → WRITE', () => {
      expect(classifyWebhookAction('pull_request_review', 'submitted')).toBe('WRITE');
    });

    it('pull_request_review_comment created → WRITE', () => {
      expect(classifyWebhookAction('pull_request_review_comment', 'created')).toBe('WRITE');
    });

    it('issue_comment created → WRITE', () => {
      expect(classifyWebhookAction('issue_comment', 'created')).toBe('WRITE');
    });
  });

  describe('PURGE tier', () => {
    it('pull_request closed → PURGE', () => {
      expect(classifyWebhookAction('pull_request', 'closed')).toBe('PURGE');
    });

    // PURGE must stay distinct from SKIP: the caller has to be able to tell
    // "nothing to do" from "retire a record", or a missed purge is invisible.
    it('is not conflated with SKIP', () => {
      expect(classifyWebhookAction('pull_request', 'closed')).not.toBe('SKIP');
    });

    it('every other pull_request action → SKIP', () => {
      for (const action of ['opened', 'synchronize', 'reopened', 'edited', 'labeled', 'ready_for_review']) {
        expect(classifyWebhookAction('pull_request', action)).toBe('SKIP');
      }
    });
  });

  describe('SKIP tiers', () => {
    it('pull_request_review_comment edited → SKIP', () => {
      expect(classifyWebhookAction('pull_request_review_comment', 'edited')).toBe('SKIP');
    });

    it('pull_request_review_comment deleted → SKIP', () => {
      expect(classifyWebhookAction('pull_request_review_comment', 'deleted')).toBe('SKIP');
    });

    it('pull_request_review dismissed → SKIP', () => {
      expect(classifyWebhookAction('pull_request_review', 'dismissed')).toBe('SKIP');
    });

    it('pull_request_review_thread unresolved → SKIP', () => {
      expect(classifyWebhookAction('pull_request_review_thread', 'unresolved')).toBe('SKIP');
    });

    it('issue_comment edited → SKIP', () => {
      expect(classifyWebhookAction('issue_comment', 'edited')).toBe('SKIP');
    });

    it('pull_request synchronize → SKIP', () => {
      expect(classifyWebhookAction('pull_request', 'synchronize')).toBe('SKIP');
    });

    it('status (any action) → SKIP', () => {
      expect(classifyWebhookAction('status', 'pending')).toBe('SKIP');
      expect(classifyWebhookAction('status', 'success')).toBe('SKIP');
      expect(classifyWebhookAction('status', 'failure')).toBe('SKIP');
    });

    it('push (any action) → SKIP', () => {
      expect(classifyWebhookAction('push', '')).toBe('SKIP');
    });

    it('unknown event → SKIP', () => {
      expect(classifyWebhookAction('star', 'created')).toBe('SKIP');
    });
  });
});

// ── isSignalWorthy ────────────────────────────────────────────────────────────

describe('isSignalWorthy', () => {
  describe('passes', () => {
    it('accepts a substantive comment', () => {
      expect(
        isSignalWorthy('Always use worktree isolation for branch-scoped changes to avoid state bleed.'),
      ).toBe(true);
    });

    it('accepts a comment that contains a code block with surrounding prose', () => {
      expect(
        isSignalWorthy(
          'Consider extracting this helper:\n\n```ts\nfunction foo() {}\n```\n\nIt is reused in three places.',
        ),
      ).toBe(true);
    });

    it('accepts a review comment with exactly 20 characters', () => {
      expect(isSignalWorthy('12345678901234567890')).toBe(true);
    });
  });

  describe('rejects', () => {
    it('rejects a body shorter than 20 characters — "LGTM"', () => {
      expect(isSignalWorthy('LGTM')).toBe(false);
    });

    it('rejects "+1"', () => {
      expect(isSignalWorthy('+1')).toBe(false);
    });

    it('rejects "ok"', () => {
      expect(isSignalWorthy('ok')).toBe(false);
    });

    it('rejects a single emoji', () => {
      expect(isSignalWorthy('👍')).toBe(false);
    });

    it('rejects a body that is only a fenced code block', () => {
      expect(isSignalWorthy('```ts\nconst x = 1;\n```')).toBe(false);
    });

    it('rejects a body that is only a fenced code block with no language tag', () => {
      expect(isSignalWorthy('```\nsome code here\n```')).toBe(false);
    });

    it('rejects CI build-passed bot noise', () => {
      expect(isSignalWorthy('Build passed ✓ — all 12 checks passed')).toBe(false);
    });

    it('rejects CI checks-failed bot noise', () => {
      expect(isSignalWorthy('Checks failed — see workflow run for details')).toBe(false);
    });

    it('rejects Dependabot header', () => {
      expect(isSignalWorthy('Bumps [lodash](https://github.com/lodash/lodash) from 4.17.20 to 4.17.21.')).toBe(
        false,
      );
    });

    it('rejects "All 3 checks passed"', () => {
      expect(isSignalWorthy('All 3 checks passed')).toBe(false);
    });
  });
});

// ── prStatePurgeTarget ────────────────────────────────────────────────────────

describe('prStatePurgeTarget', () => {
  const merged = {
    repository: { full_name: 'mthines/agent-skills' },
    pull_request: { number: 123, merged: true, head: { ref: 'feat/x' } },
  };

  it('builds the scope and key pr-reviewer reads', () => {
    expect(prStatePurgeTarget('pull_request', 'closed', merged)).toEqual({
      scope: 'branch::mthines/agent-skills::feat/x',
      key: 'ci-state::pr-review-123',
    });
  });

  it('handles a head ref containing slashes', () => {
    const t = prStatePurgeTarget('pull_request', 'closed', {
      ...merged,
      pull_request: { ...merged.pull_request, head: { ref: 'claude/pr-reviewer-single-comment-alpusg' } },
    });
    expect(t?.scope).toBe('branch::mthines/agent-skills::claude/pr-reviewer-single-comment-alpusg');
  });

  // A close without a merge is NOT terminal — the PR can be reopened and
  // reviewed again, and the carried findings are still wanted then.
  it('returns null for a close without a merge', () => {
    expect(
      prStatePurgeTarget('pull_request', 'closed', {
        ...merged,
        pull_request: { ...merged.pull_request, merged: false },
      }),
    ).toBeNull();
  });

  it('returns null when merged is absent entirely', () => {
    expect(
      prStatePurgeTarget('pull_request', 'closed', {
        repository: { full_name: 'o/r' },
        pull_request: { number: 1, head: { ref: 'b' } },
      }),
    ).toBeNull();
  });

  // Never widen to a prefix delete to cover a missing field: an exact key or
  // nothing at all.
  it.each([
    ['no repository', { pull_request: { number: 1, merged: true, head: { ref: 'b' } } }],
    ['no head ref', { repository: { full_name: 'o/r' }, pull_request: { number: 1, merged: true } }],
    ['no number', { repository: { full_name: 'o/r' }, pull_request: { merged: true, head: { ref: 'b' } } }],
    ['no pull_request', { repository: { full_name: 'o/r' } }],
  ])('returns null when the payload has %s', (_label, payload) => {
    expect(prStatePurgeTarget('pull_request', 'closed', payload)).toBeNull();
  });

  it('returns null for a non-purge event, even with a merged PR in the payload', () => {
    expect(prStatePurgeTarget('pull_request_review', 'submitted', merged)).toBeNull();
    expect(prStatePurgeTarget('pull_request', 'opened', merged)).toBeNull();
  });

  // PR number 0 is not a real PR, but `!num` would also reject it by accident;
  // the guard is a typeof check, so assert the boundary explicitly.
  it('accepts a numeric zero only as a number, not via falsiness', () => {
    const t = prStatePurgeTarget('pull_request', 'closed', {
      repository: { full_name: 'o/r' },
      pull_request: { number: 0, merged: true, head: { ref: 'b' } },
    });
    expect(t?.key).toBe('ci-state::pr-review-0');
  });
});
