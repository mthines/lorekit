import { redirect } from 'next/navigation';

// /onboarding has moved to /learn/setup.
// Redirect so existing deep links, bookmarks, and agent config references keep working.
export default function OnboardingRedirectPage() {
  redirect('/learn/setup');
}
