import { redirect } from 'next/navigation';

// /tutorials/remote has moved to /learn/remote.
export default function TutorialRedirectPage() {
  redirect('/learn/remote');
}
