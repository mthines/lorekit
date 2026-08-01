import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { MDXRemote } from 'next-mdx-remote/rsc';
import { getAllPosts, getPost } from '@/lib/blog/content';
import { blogMdxComponents } from '@/components/blog/mdx-components';
import { blogMdxOptions } from '@/lib/blog/mdx-render-options';
import { BlogProse } from '@/components/blog/BlogProse';
import { TableOfContents } from '@/components/blog/TableOfContents';
import { ReadingProgress } from '@/components/blog/ReadingProgress';
import { formatPostDate, readingLabel } from '@/lib/blog/format';

// Statically generate one page per known post slug; reject anything else (404).
export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}
export const dynamicParams = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.description,
    authors: post.author ? [{ name: post.author }] : undefined,
    keywords: post.keywords,
  };
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  return (
    <>
      <ReadingProgress />

      <div className="mx-auto max-w-5xl lg:flex lg:justify-center lg:gap-12">
        <article className="mx-auto min-w-0 max-w-2xl lg:mx-0 lg:flex-1">
          <Link
            href="/blog"
            className="mb-8 inline-flex items-center gap-1.5 text-sm text-[var(--color-content-tertiary)] transition-colors hover:text-[var(--color-content-primary)]"
          >
            <ArrowLeft className="size-4" aria-hidden />
            All posts
          </Link>

          <header className="mb-8 border-b border-[var(--color-border)] pb-8">
            <h1 className="text-2xl font-bold leading-tight tracking-tight text-[var(--color-content-primary)] sm:text-3xl">
              {post.title}
            </h1>
            {post.description && (
              <p className="mt-3 text-base leading-relaxed text-[var(--color-content-secondary)]">
                {post.description}
              </p>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-2 font-mono text-xs text-[var(--color-content-tertiary)]">
              {post.author && (
                <>
                  <span className="text-[var(--color-content-secondary)]">{post.author}</span>
                  <span aria-hidden>·</span>
                </>
              )}
              {post.date && (
                <>
                  <time dateTime={post.date}>{formatPostDate(post.date)}</time>
                  <span aria-hidden>·</span>
                </>
              )}
              <span>{readingLabel(post.readingMinutes)}</span>
            </div>
          </header>

          <BlogProse>
            <MDXRemote source={post.body} components={blogMdxComponents} options={blogMdxOptions} />
          </BlogProse>
        </article>

        {post.toc.length > 0 && (
          <aside className="mt-12 hidden shrink-0 lg:mt-0 lg:block lg:w-56">
            {/* Sticky so the TOC stays in view; `top-20` clears the sticky header
                + reading-progress bar. Its own scroll for very long posts. */}
            <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto py-1">
              <TableOfContents items={post.toc} />
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
