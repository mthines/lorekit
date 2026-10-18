import { redirect } from 'next/navigation';

// /onboarding has moved to /learn/setup.
// Redirect so existing deep links, bookmarks, and agent config references keep working.
// No loading.tsx beside this page: its Suspense boundary streams the redirect to the
// client, and that client-side hop crashes Next's app-router (React error #310).
export default function OnboardingRedirectPage() {
  redirect('/learn/setup');
}
