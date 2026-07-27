import { redirect } from 'next/navigation';

// /tutorials has no content of its own — redirect to the first tutorial.
export default function TutorialsIndexPage() {
  redirect('/tutorials/offline');
}
