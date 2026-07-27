import { redirect } from 'next/navigation';

// /tutorials/organization has moved to /learn/organization.
export default function TutorialRedirectPage() {
  redirect('/learn/organization');
}
