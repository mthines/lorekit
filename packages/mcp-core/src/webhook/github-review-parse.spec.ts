import { describe, it, expect } from 'vitest';
import { parseThreadNode } from './github-review-parse.js';

/** A well-formed node with one root comment and nothing unusual. */
function node(rootOverrides: Record<string, unknown> = {}, nodeOverrides: Record<string, unknown> = {}) {
  return {
    isResolved: false,
    isOutdated: false,
    comments: {
      nodes: [
        {
          databaseId: 4242,
          body: 'issue: this is wrong',
          path: 'src/a.ts',
          line: 11,
          author: { login: 'reviewer', __typename: 'Bot' },
          commit: { oid: 'headsha' },
          originalCommit: { oid: 'origsha' },
          reactions: { nodes: [] },
          ...rootOverrides,
        },
      ],
    },
    ...nodeOverrides,
  };
}

describe('parseThreadNode', () => {
  it('flattens a well-formed node', () => {
    expect(parseThreadNode(node())).toEqual({
      isResolved: false,
      isOutdated: false,
      rootCommentId: 4242,
      rootBody: 'issue: this is wrong',
      rootPath: 'src/a.ts',
      rootLine: 11,
      rootAuthorLogin: 'reviewer',
      rootAuthorIsBot: true,
      rootCommitSha: 'origsha',
      replies: [],
      thumbsDownLogins: [],
    });
  });

  it('carries the thread flags through as booleans', () => {
    const parsed = parseThreadNode(node({}, { isResolved: true, isOutdated: true }));
    expect(parsed).toMatchObject({ isResolved: true, isOutdated: true });
  });

  describe('returns null when there is nothing to classify', () => {
    it('for a node with no comments', () => {
      expect(parseThreadNode({ comments: { nodes: [] } })).toBeNull();
    });

    it('for a missing comments connection, and for no node at all', () => {
      expect(parseThreadNode({})).toBeNull();
      expect(parseThreadNode(null)).toBeNull();
      expect(parseThreadNode(undefined)).toBeNull();
    });
  });

  describe('the compare anchor', () => {
    it('prefers originalCommit over commit', () => {
      // `commit` advances when GitHub re-anchors a thread onto a later commit,
      // which would start the compare range AFTER the commits it must inspect.
      expect(parseThreadNode(node())?.rootCommitSha).toBe('origsha');
    });

    it('falls back to commit when originalCommit is absent', () => {
      expect(parseThreadNode(node({ originalCommit: undefined }))?.rootCommitSha).toBe('headsha');
      expect(parseThreadNode(node({ originalCommit: { oid: null } }))?.rootCommitSha).toBe('headsha');
    });

    it('is null when neither is a string, rather than a plausible wrong value', () => {
      expect(
        parseThreadNode(node({ originalCommit: {}, commit: {} }))?.rootCommitSha,
      ).toBeNull();
      expect(
        parseThreadNode(node({ originalCommit: { oid: 42 }, commit: { oid: 42 } }))?.rootCommitSha,
      ).toBeNull();
    });
  });

  describe('the line anchor', () => {
    it('is null once the anchor has moved off the diff', () => {
      expect(parseThreadNode(node({ line: null }))?.rootLine).toBeNull();
    });

    it('is null for a non-positive line, which is not a line', () => {
      expect(parseThreadNode(node({ line: 0 }))?.rootLine).toBeNull();
      expect(parseThreadNode(node({ line: -1 }))?.rootLine).toBeNull();
    });

    it('is null for a non-numeric line', () => {
      expect(parseThreadNode(node({ line: '11' }))?.rootLine).toBeNull();
    });
  });

  describe('the path anchor', () => {
    it('is null when absent or empty', () => {
      expect(parseThreadNode(node({ path: undefined }))?.rootPath).toBeNull();
      expect(parseThreadNode(node({ path: '' }))?.rootPath).toBeNull();
    });
  });

  describe('the author', () => {
    it('flags a Bot by __typename, not by a name convention', () => {
      expect(parseThreadNode(node())?.rootAuthorIsBot).toBe(true);
      expect(
        parseThreadNode(node({ author: { login: 'coderabbitai[bot]', __typename: 'User' } }))
          ?.rootAuthorIsBot,
      ).toBe(false);
    });

    it('survives a deleted author', () => {
      const parsed = parseThreadNode(node({ author: null }));
      expect(parsed).toMatchObject({ rootAuthorLogin: null, rootAuthorIsBot: false });
    });
  });

  describe('replies', () => {
    it('are every comment after the root, in order', () => {
      const n = node();
      n.comments.nodes.push(
        { body: 'wont fix' } as never,
        { body: 'agreed' } as never,
      );
      expect(parseThreadNode(n)?.replies).toEqual(['wont fix', 'agreed']);
    });

    it('drop empty and non-string bodies rather than becoming empty strings', () => {
      // An empty reply cannot decline anything, and a '' in the list would be
      // handed to DECLINE_PATTERN as if it were a real reply.
      const n = node();
      n.comments.nodes.push({ body: '' } as never, { body: null } as never, {} as never);
      expect(parseThreadNode(n)?.replies).toEqual([]);
    });

    it('never include the root comment itself', () => {
      expect(parseThreadNode(node())?.replies).toEqual([]);
    });
  });

  describe('thumbs-down logins', () => {
    it('collects every reacting login', () => {
      const parsed = parseThreadNode(
        node({ reactions: { nodes: [{ user: { login: 'alice' } }, { user: { login: 'bob' } }] } }),
      );
      expect(parsed?.thumbsDownLogins).toEqual(['alice', 'bob']);
    });

    it('drops a reaction from a deleted user rather than yielding undefined', () => {
      const parsed = parseThreadNode(
        node({ reactions: { nodes: [{ user: null }, {}, { user: { login: 'alice' } }] } }),
      );
      expect(parsed?.thumbsDownLogins).toEqual(['alice']);
    });

    it('is empty when the reactions connection is absent', () => {
      expect(parseThreadNode(node({ reactions: undefined }))?.thumbsDownLogins).toEqual([]);
    });
  });

  it('reads a missing databaseId as null, never as 0', () => {
    // 0 is a valid-looking comment id and would be matched against the resolved
    // thread's root id, so the absent case must stay distinguishable.
    expect(parseThreadNode(node({ databaseId: undefined }))?.rootCommentId).toBeNull();
    expect(parseThreadNode(node({ databaseId: '4242' }))?.rootCommentId).toBeNull();
  });

  it('reads a missing body as an empty string, so marker extraction is total', () => {
    expect(parseThreadNode(node({ body: undefined }))?.rootBody).toBe('');
  });
});
