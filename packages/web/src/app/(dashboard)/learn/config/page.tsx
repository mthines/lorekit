import { redirect } from 'next/navigation';

// Moved to the public docs. Kept as a redirect so old /learn/config links resolve.
export default function LearnRedirect() {
  redirect('/docs/config');
}
