import { redirect } from 'next/navigation';

/**
 * Public redirect from the old `/learn/*` paths to the docs at `/docs/*`.
 *
 * This lives OUTSIDE the `(dashboard)` group on purpose: the docs are now public,
 * so an old `/learn/remote` link must resolve to `/docs/remote` for a logged-out
 * visitor too — an auth-gated stub would bounce them to `/login` instead. Kept as
 * the seam for a future curated in-dashboard onboarding; for now it just forwards.
 */
export default async function LearnRedirect({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const rest = slug?.join('/');
  redirect(rest ? `/docs/${rest}` : '/docs');
}
