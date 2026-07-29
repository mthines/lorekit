import { redirect } from 'next/navigation';

// /tutorials/tags has moved to /learn/tags.
export default function TutorialRedirectPage() {
  redirect('/learn/tags');
}
