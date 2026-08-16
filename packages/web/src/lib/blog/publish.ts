/**
 * A post is published once its frontmatter `date` — its UTC calendar day — is on
 * or before today (UTC). Future-dated posts are drafts: {@link getAllPosts}
 * drops them from the `/blog` index, and because `generateStaticParams` derives
 * from that same list (with `dynamicParams = false`), their URL 404s until the
 * date arrives. So a finished post can be committed ahead of its announce date
 * and goes live on the first build produced on or after it — no code change, just
 * a redeploy. The pages are statically generated, so the date does NOT flip the
 * post live on its own: it needs a build after the date (a merge to `main`, or any
 * later deploy). If a post must go live exactly on its date, trigger a deploy then.
 *
 * An unparseable date is treated as PUBLISHED (fail-open), matching
 * {@link formatPostDate}'s "degrade, don't hide" stance: a typo must never
 * silently bury a real post. `sections.spec.ts` already enforces the YYYY-MM-DD
 * shape for every registered post, so fail-open isn't a hole in practice.
 *
 * Day-granular on purpose — a post dated today is live from the start of the day
 * in UTC, not at some hour. Comparing whole UTC days keeps that boundary stable
 * regardless of the build machine's clock time within the day.
 */
export function isPublished(dateStr: string, now: Date = new Date()): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!parts) return true;
  const postDay = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return postDay <= today;
}
