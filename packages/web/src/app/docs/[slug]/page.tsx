import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MDXRemote } from 'next-mdx-remote/rsc';
import { getAllDocs, getDoc } from '@/lib/docs/content';
import { docsMdxComponents } from '@/components/docs/mdx-components';
import { docsMdxOptions } from '@/lib/docs/mdx-render-options';
import { DocsProse } from '@/components/docs/DocsProse';

// Statically generate one page per known doc slug; reject anything else (404)
// rather than attempting a dynamic render of an unknown file.
export function generateStaticParams() {
  return getAllDocs().map((doc) => ({ slug: doc.slug }));
}
export const dynamicParams = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) return {};
  return { title: doc.title, description: doc.description };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) notFound();

  return (
    <article>
      <header className="mb-2">
        <h1 className="text-2xl font-bold tracking-tight text-[var(--color-content-primary)]">
          {doc.title}
        </h1>
        {doc.description && (
          <p className="mt-2 text-sm leading-relaxed text-[var(--color-content-secondary)]">
            {doc.description}
          </p>
        )}
      </header>

      <DocsProse>
        <MDXRemote source={doc.body} components={docsMdxComponents} options={docsMdxOptions} />
      </DocsProse>
    </article>
  );
}
