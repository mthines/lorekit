/**
 * `/learn/*` now redirects to the public `/docs/*` section (the pages here are
 * thin redirect stubs). This layout is intentionally a pass-through — the docs
 * chrome (nav rail, search) lives in `app/docs/layout.tsx`. Kept as a route so
 * old `/learn/...` links keep resolving; slated to become a curated in-dashboard
 * onboarding that links into the docs.
 */
export default function LearnLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
