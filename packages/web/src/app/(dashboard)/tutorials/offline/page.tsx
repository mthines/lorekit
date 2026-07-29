import { redirect } from 'next/navigation';

// /tutorials/offline has moved to /learn/offline.
export default function TutorialRedirectPage() {
  redirect('/learn/offline');
}
