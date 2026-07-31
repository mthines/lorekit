'use client';

/**
 * DocsCommands
 *
 * Registers docs-navigation commands for the public `/docs` command palette,
 * mirroring `NavigationCommands`'s `DocsCommandItem`/`DocsCommands` pattern.
 *
 * One command per `DOCS_SECTIONS` page (driven by the single shared table so the
 * palette can never drift from the nav rail or the full-text search box), plus
 * the external REST API reference. Each item is its own component so `useCommand`
 * is called at a stable hook position rather than inside a `.map()` in the parent.
 *
 * Mount this once inside `CommandPaletteProvider` (done in the docs layout).
 */

import { useRouter } from 'next/navigation';
import { FileCode } from 'lucide-react';
import { useCommand } from '@/components/command/useCommand';
import { DOCS_SECTIONS, type DocsSection } from '@/lib/docs/sections';

function DocsCommandItem({ section }: { section: DocsSection }) {
  const router = useRouter();
  const Icon = section.icon;
  useCommand({
    id: `docs-nav-${section.id}`,
    label: section.label,
    description: section.summary,
    icon: <Icon className="size-4" />,
    group: 'Docs',
    onSelect: () => router.push(`/docs/${section.id}`),
  });
  return null;
}

function DocsApiReferenceCommand() {
  useCommand({
    id: 'docs-nav-api-reference',
    label: 'API Reference',
    description: 'Open the REST API docs (opens in a new tab)',
    icon: <FileCode className="size-4" />,
    group: 'Docs',
    onSelect: () => {
      window.open('/api-docs', '_blank', 'noopener,noreferrer');
    },
  });
  return null;
}

export function DocsCommands() {
  return (
    <>
      {DOCS_SECTIONS.map((section) => (
        <DocsCommandItem key={section.id} section={section} />
      ))}
      <DocsApiReferenceCommand />
    </>
  );
}
