import { describe, it, expect } from 'vitest';
import { classifyWebhookAction, isSignalWorthy } from './signal-filter.js';

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
