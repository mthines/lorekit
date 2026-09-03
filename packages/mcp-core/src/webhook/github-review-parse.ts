/**
 * Pure parsing of GitHub's review-thread GraphQL shape — no I/O.
 *
 * The comment-relevance classifier asks GitHub one paginated GraphQL query and
 * then reasons entirely over the result.  This module is the boundary between
 * those two halves: it turns one `reviewThreads.nodes[]` entry into the flat
 * `ReviewThreadFacts` the decision tables consume, and it is where every
 * "which field do we actually trust" rule lives.
 *
 * Those rules are not obvious, and getting one wrong is silent — a thread parsed
 * with the wrong commit anchors its `compare` at the wrong point in history, and
 * every touch verdict downstream is then confidently wrong about a question it
 * never asked.  So they live here, in a module with a spec, rather than inline
 * in the fetch shell where nothing exercises them.
 *
 * Mirrored (self-contained, no cross-package import) into
 * supabase/functions/mcp/github-review-parse.ts for the Deno edge function —
 * the same pattern as comment-relevance.ts.  Keep the two in sync when either
 * changes (guarded by edge-parity.spec.ts).
 */

export interface ReviewThreadFacts {
  isResolved: boolean;
  isOutdated: boolean;
  /** REST id of the root comment — what a marker-bearing comment is keyed by. */
  rootCommentId: number | null;
  rootBody: string;
  rootPath: string | null;
  /** Null for a file-level comment, and for a comment whose anchor moved away. */
  rootLine: number | null;
  rootAuthorLogin: string | null;
  rootAuthorIsBot: boolean;
  /** The commit the root comment was written against — the `compare` base. */
  rootCommitSha: string | null;
  /** Reply bodies after the root comment. */
  replies: string[];
  /** Logins that reacted 👎 to the ROOT comment. */
  thumbsDownLogins: string[];
}

// The raw GraphQL shape, typed as what it actually is: a tree in which every
// field may be absent or null, and no field may be trusted to have the type its
// name suggests.  Declaring each leaf `unknown` rather than `string`/`number` is
// the point — it forces every read below through an explicit `typeof` narrowing
// instead of letting a plausible-looking wrong value through.
interface RawCommit {
  oid?: unknown;
}

interface RawComment {
  databaseId?: unknown;
  body?: unknown;
  path?: unknown;
  line?: unknown;
  author?: { login?: unknown; __typename?: unknown } | null;
  commit?: RawCommit | null;
  originalCommit?: RawCommit | null;
  reactions?: { nodes?: readonly ({ user?: { login?: unknown } | null } | null)[] | null } | null;
}

interface RawThreadNode {
  isResolved?: unknown;
  isOutdated?: unknown;
  comments?: { nodes?: readonly (RawComment | null)[] | null } | null;
}

/**
 * One `reviewThreads.nodes[]` entry → flat facts, or `null` when the node
 * carries no comments at all and there is therefore nothing to classify.
 *
 * Every field is read defensively rather than trusted, because a thread that
 * parses into plausible-looking wrong values is worse than one that is dropped:
 * the decision tables cannot tell a fabricated field from a real one, and their
 * whole contract is that they refuse to write when the evidence cannot decide.
 */
export function parseThreadNode(node: unknown): ReviewThreadFacts | null {
  // The parameter is `unknown` because that is what a parsed HTTP body is. The
  // cast below asserts nothing about the contents: every field of RawThreadNode
  // is optional and every leaf is `unknown`, so it buys named fields and no
  // guarantees.
  if (typeof node !== 'object' || node === null) return null;
  const thread = node as RawThreadNode;

  const comments = (thread.comments?.nodes ?? []).filter(
    (c): c is RawComment => typeof c === 'object' && c !== null,
  );
  const root = comments[0];
  if (!root) return null;

  const originalOid = root.originalCommit?.oid;
  const currentOid = root.commit?.oid;

  return {
    isResolved: !!thread.isResolved,
    isOutdated: !!thread.isOutdated,
    rootCommentId: typeof root.databaseId === 'number' ? root.databaseId : null,
    rootBody: typeof root.body === 'string' ? root.body : '',
    rootPath: typeof root.path === 'string' && root.path.length > 0 ? root.path : null,
    // GraphQL reports `line` as null once the anchor has moved off the diff,
    // which is the same shape as a file-level comment. Both are "no line", and
    // the decision tables handle them identically.
    rootLine: typeof root.line === 'number' && root.line > 0 ? root.line : null,
    rootAuthorLogin: typeof root.author?.login === 'string' ? root.author.login : null,
    rootAuthorIsBot: root.author?.__typename === 'Bot',
    // `commit` is the comment's current commit; `originalCommit` is where it was
    // first written. Prefer the original: "did anything land AFTER the comment"
    // is anchored at the comment's own point in history, and `commit` advances
    // when GitHub re-anchors a thread onto a later commit — which would make the
    // compare range start after the very commits it is meant to inspect.
    rootCommitSha:
      typeof originalOid === 'string'
        ? originalOid
        : typeof currentOid === 'string'
          ? currentOid
          : null,
    replies: comments
      .slice(1)
      .map((c) => (typeof c.body === 'string' ? c.body : ''))
      .filter(Boolean),
    thumbsDownLogins: (root.reactions?.nodes ?? [])
      .map((r) => r?.user?.login)
      .filter((login): login is string => typeof login === 'string'),
  };
}
