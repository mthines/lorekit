import { redirect } from 'next/navigation';

// /tutorials/use-cases has moved to /learn/use-cases.
export default function TutorialRedirectPage() {
  redirect('/learn/use-cases');
}
