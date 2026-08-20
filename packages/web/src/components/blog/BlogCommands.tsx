'use client';

/**
 * BlogCommands
 *
 * Registers one command per blog post for the public `/blog` command palette,
 * mirroring `DocsCommands`'s `DocsCommandItem`/`DocsCommands` pattern.
 *
 * Driven by the single shared `BLOG_SECTIONS` table (the same source the `/blog`
 * index and the `sections.spec.ts` drift guard use) so the palette can never
 * drift from the post list — adding a post registers it here automatically. Each
 * item is its own component so `useCommand` is called at a stable hook position
 * rather than inside a `.map()` in the parent.
 *
 * The post `summary` is passed as `description`: the palette no longer renders a
 * second line, but `matchesSearch` still indexes the description, so typing a
 * word from a post's summary surfaces it — i.e. "search in blog".
 *
 * Mount this once inside `CommandPaletteProvider` (done in the blog layout).
 */

import { useRouter } from 'next/navigation';
import { Newspaper } from 'lucide-react';
import { useCommand } from '@/components/command/useCommand';
import { BLOG_SECTIONS, type BlogSection } from '@/lib/blog/sections';

function BlogPostCommand({ section }: { section: BlogSection }) {
  const router = useRouter();
  useCommand({
    id: `blog-post-${section.id}`,
    label: section.label,
    description: section.summary,
    icon: <Newspaper className="size-4" />,
    group: 'Blog',
    onSelect: () => router.push(`/blog/${section.id}`),
  });
  return null;
}

export function BlogCommands() {
  return (
    <>
      {BLOG_SECTIONS.map((section) => (
        <BlogPostCommand key={section.id} section={section} />
      ))}
    </>
  );
}
