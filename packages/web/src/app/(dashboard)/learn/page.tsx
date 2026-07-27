import { redirect } from 'next/navigation';

// /learn lands on the setup checklist — the natural first destination.
export default function LearnIndexPage() {
  redirect('/learn/setup');
}
