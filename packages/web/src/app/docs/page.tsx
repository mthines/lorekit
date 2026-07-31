import { redirect } from 'next/navigation';
import { DOCS_SECTIONS } from '@/lib/docs/sections';

// `/docs` lands on the first section (Getting started), derived from the single
// DOCS_SECTIONS source so this stays correct if the reading order ever changes.
// The nav rail + search take over from there.
export default function DocsIndexPage() {
  redirect(`/docs/${DOCS_SECTIONS[0]?.id ?? 'setup'}`);
}
