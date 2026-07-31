import { redirect } from 'next/navigation';

// `/docs` lands on the first section (Getting started). The nav rail + search
// take over from there.
export default function DocsIndexPage() {
  redirect('/docs/setup');
}
