import type { Metadata } from 'next';
import { getAllPosts } from '@/lib/blog/content';
import { BlogPostCard } from '@/components/blog/BlogPostCard';

export const metadata: Metadata = {
  title: 'Blog',
  description:
    'Notes on shared, persistent memory for AI coding agents — self-healing loops, scopes, and the engineering behind LoreKit.',
};

/**
 * The `/blog` index — a single readable column of post cards, newest first (the
 * `getAllPosts` order). Statically generated from the MDX under
 * `src/content/blog/*`.
 */
export default function BlogIndexPage() {
  const posts = getAllPosts();

  return (
    <main className="mx-auto max-w-2xl">
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-[var(--color-content-primary)]">
          Blog
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-content-secondary)]">
          Notes from the team building LoreKit — shared, persistent memory for AI coding agents.
        </p>
      </header>

      {posts.length === 0 ? (
        <p className="text-sm text-[var(--color-content-tertiary)]">No posts yet. Check back soon.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {posts.map((post) => (
            <li key={post.slug}>
              <BlogPostCard post={post} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
