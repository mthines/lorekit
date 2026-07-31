import { redirect } from 'next/navigation';

// Moved to the public docs. Kept as a redirect so old /learn/use-cases links resolve.
export default function LearnRedirect() {
  redirect('/docs/use-cases');
}
