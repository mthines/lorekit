import { redirect } from 'next/navigation';

// /tutorials has moved to /learn/offline (first tutorial).
// Redirect so existing deep links keep working.
export default function TutorialsRedirectPage() {
  redirect('/learn/offline');
}
