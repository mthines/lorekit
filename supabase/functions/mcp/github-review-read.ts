/**
 * GitHub reads for the comment-relevance classifier — the impure shell around
 * two pure, spec'd modules: ./github-review-parse.ts turns a GraphQL node into
 * flat facts, and ./comment-relevance.ts decides what those facts mean.  This
 * file owns only the HTTP calls, their pagination, and their budget; every
 * judgement it would otherwise make inline lives in one of those two.
 *
 * Everything here runs on an INSTALLATION access token, so it can only ever see
 * repositories the account actually installed the App on.  Every function fails
 * soft: a read that could not be completed returns a value the caller can tell
 * apart from a real answer (`complete: false`, or `null`), never a plausible
 * default.  That distinction is the whole point — the decision tables treat
 * "could not read" as undecidable and write nothing, and handing them a
 * fabricated `false` would turn a rate limit into a stream of false
 * suppressions.
 *
 * Cost discipline.  This runs inline on a webhook delivery, so the read budget
 * is fixed rather than proportional to the pull request:
 *
 *   • Thread facts — ONE paginated GraphQL query returns every thread's
 *     resolution state, staleness, anchor, author, replies AND 👎 reactions.
 *     The REST equivalents are one call per thread for reactions alone, and
 *     REST cannot report thread resolution at all.
 *   • Touch evidence — ONE `compare` call per distinct commit, memoised, rather
 *     than one per commit on the branch.  `compare(<comment's commit>…<head>)`
 *     is exactly the question "did anything land after this comment", so the
 *     call count is bounded by the number of distinct commits the open threads
 *     were written against, not by the branch length.
 *   • Both are additionally capped, and hitting a cap reports UNDECIDABLE.
 */

import {
  filesFromCompareBody,
  touchEvidenceFromFiles,
  type ComparedFile,
  type TouchEvidence,
} from './comment-relevance.ts';
import { parseThreadNode, type ReviewThreadFacts } from './github-review-parse.ts';

const GITHUB_API = 'https://api.github.com';

/** Threads per GraphQL page, and the page ceiling. 20 × 50 = 1,000 threads. */
const THREAD_PAGE_SIZE = 50;
const MAX_THREAD_PAGES = 20;

/**
 * Comments fetched per thread. A thread longer than this has its replies
 * truncated, which can only HIDE a decline — so the cap is deliberately high
 * enough that reaching it means something other than a code review.
 */
const THREAD_COMMENT_PAGE_SIZE = 50;

/**
 * Distinct commits we will run a `compare` against in one delivery. Threads
 * beyond it get `null` touch evidence, i.e. undecidable, i.e. no record.
 */
const MAX_TOUCH_COMPARES = 12;

export interface ReviewThreadRead {
  /**
   * False when the walk stopped early — a query failure or the page ceiling.
   * Treat the list as unusable rather than as "there are no more threads".
   */
  complete: boolean;
  threads: ReviewThreadFacts[];
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'lorekit-app',
  };
}

const REVIEW_THREADS_QUERY = `
  query($owner:String!,$repo:String!,$pr:Int!,$cursor:String,$threads:Int!,$comments:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$pr){
        reviewThreads(first:$threads, after:$cursor){
          pageInfo{ hasNextPage endCursor }
          nodes{
            isResolved
            isOutdated
            comments(first:$comments){
              nodes{
                databaseId
                body
                path
                line
                author{ login __typename }
                commit{ oid }
                originalCommit{ oid }
                # content is selected even though the argument already narrows
                # to 👎: parseThreadNode re-checks it, so losing this filter
                # drops the reactions instead of silently reading a 👍 as a 👎
                # on a suppression input.
                reactions(content: THUMBS_DOWN, first: 20){
                  nodes{ content user{ login } }
                }
              }
            }
          }
        }
      }
    }
  }`;

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

/**
 * Every review thread on a pull request, with the fields REST cannot supply.
 *
 * `isResolved` is what keeps the merge sweep from re-recording a thread the
 * resolved-thread path already owns; `isOutdated` is what keeps a deleted
 * anchor from being read as an accepted fix.  Neither exists in the REST
 * review-comments API, which is why this is GraphQL.
 */
export async function fetchReviewThreads(args: {
  token: string;
  owner: string;
  repo: string;
  pr: number;
}): Promise<ReviewThreadRead> {
  const threads: ReviewThreadFacts[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    let body: Json;
    try {
      const res = await fetch(`${GITHUB_API}/graphql`, {
        method: 'POST',
        headers: { ...githubHeaders(args.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: REVIEW_THREADS_QUERY,
          variables: {
            owner: args.owner,
            repo: args.repo,
            pr: args.pr,
            cursor,
            threads: THREAD_PAGE_SIZE,
            comments: THREAD_COMMENT_PAGE_SIZE,
          },
        }),
      });
      if (!res.ok) return { complete: false, threads };
      body = await res.json();
    } catch {
      return { complete: false, threads };
    }

    // A GraphQL 200 can still carry errors and a null data tree. Either way the
    // page did not arrive, and a partial page must not read as a final one.
    if (body['errors']) return { complete: false, threads };
    const conn = body['data']?.repository?.pullRequest?.reviewThreads;
    if (!conn) return { complete: false, threads };

    for (const node of conn.nodes ?? []) {
      const parsed = parseThreadNode(node);
      if (parsed) threads.push(parsed);
    }

    if (!conn.pageInfo?.hasNextPage) return { complete: true, threads };
    cursor = conn.pageInfo.endCursor ?? null;
    if (!cursor) return { complete: false, threads };
  }

  // Ran out of pages with more to fetch.
  return { complete: false, threads };
}

/**
 * A memoised `compare`-backed touch check.
 *
 * One instance per delivery. `evidenceFor` answers, for one thread, whether
 * anything landed on its anchor after the comment was written — or `null` when
 * that cannot be established, which the decision tables read as undecidable.
 *
 * The cap is on distinct COMMITS, not threads: a review posts many comments
 * against one commit, so the common case is one HTTP call for the whole sweep.
 */
export class TouchProbe {
  private readonly cache = new Map<string, ComparedFile[] | null>();
  private compares = 0;

  constructor(
    private readonly token: string,
    private readonly repo: string,
    private readonly headSha: string,
  ) {}

  /** How many `compare` calls this probe actually made — for OTel. */
  get callCount(): number {
    return this.compares;
  }

  async evidenceFor(thread: ReviewThreadFacts): Promise<TouchEvidence | null> {
    if (!thread.rootPath) return null;
    if (!thread.rootCommitSha || !this.headSha) return null;

    // Nothing landed after the comment: the anchor commit IS the head. An empty
    // file list says exactly that — a walk that completed and did not contain
    // this file — so the answer still comes from the pure module rather than
    // from a second copy of its granularity rule here.
    if (thread.rootCommitSha === this.headSha) {
      return touchEvidenceFromFiles([], thread.rootPath, thread.rootLine);
    }

    // The decision itself lives in the pure, spec'd, drift-guarded module. This
    // class owns the HTTP call and its memo and nothing else, so the branch that
    // decides between "untouched" and "cannot tell" is testable — `filesSince`
    // already collapses every unreadable condition to `null`, which
    // `touchEvidenceFromFiles` reads as undecidable.
    const files = await this.filesSince(thread.rootCommitSha);
    return touchEvidenceFromFiles(files, thread.rootPath, thread.rootLine);
  }

  /**
   * `null` on any condition that makes the answer unknowable.
   *
   * Which conditions those are is `filesFromCompareBody`'s call, not this
   * method's: it owns both the truncation ceiling and the absent-key case, and
   * it is spec'd. All this method decides is whether an HTTP response arrived
   * at all.
   */
  private async filesSince(baseSha: string): Promise<ComparedFile[] | null> {
    if (this.cache.has(baseSha)) return this.cache.get(baseSha) ?? null;
    if (this.compares >= MAX_TOUCH_COMPARES) return null;

    this.compares++;
    let result: ComparedFile[] | null = null;
    try {
      const res = await fetch(
        `${GITHUB_API}/repos/${this.repo}/compare/${baseSha}...${this.headSha}`,
        { headers: githubHeaders(this.token) },
      );
      if (res.ok) result = filesFromCompareBody(await res.json());
    } catch {
      result = null;
    }
    // Cache the failure too: retrying the same unreachable compare once per
    // thread is how a bounded read budget becomes an unbounded one.
    this.cache.set(baseSha, result);
    return result;
  }
}
