import { redirect } from 'next/navigation';

// /tutorials/private has moved to /learn/private.
export default function TutorialRedirectPage() {
  redirect('/learn/private');
}
