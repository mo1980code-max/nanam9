/**
 * /[slug] — the page builder's public renderer (about, contact, privacy, terms…).
 *
 * This route is the *last* segment matcher, so real routes (/games, /game, /blog…) always
 * win. If the slug is not a published page we call notFound() rather than rendering an
 * empty shell: a soft 404 with a 200 status is exactly what search engines penalise.
 *
 * Editors compose these pages from blocks in the admin panel; no deploy is involved.
 * That is the answer to "the competitor themes only ship four fixed pages".
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Blocks } from '@/components/blocks';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { Markdown } from '@/components/markdown';
import { getPage, siteUrl } from '@/lib/api';

export const revalidate = 60;

type Params = { slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await getPage(slug);
  if (!page) return {};
  const title = page.seo?.title || page.title;
  return {
    title,
    description: page.seo?.description || undefined,
    alternates: { canonical: page.seo?.canonical || `/${page.slug}` },
    openGraph: { type: 'website', title, url: siteUrl(`/${page.slug}`) },
    robots: page.isIndexed === false ? { index: false, follow: false } : undefined,
  };
}

export default async function CmsPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const page = await getPage(slug);
  if (!page) notFound();

  const blocks = page.blocks ?? [];
  // A page whose first block is a hero already provides its own H1; adding another would
  // give the document two, which is both an accessibility and an SEO smell.
  const heroIsFirst = blocks[0]?.type === 'hero';

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <Breadcrumbs trail={[{ name: 'الرئيسية', url: '/' }, { name: page.title, url: `/${page.slug}` }]} />

      {(page.jsonLd ?? []).map((node, index) => (
        <script key={index} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(node) }} />
      ))}

      {!heroIsFirst ? (
        <header className="mb-6">
          <h1 className="text-2xl font-black text-ink sm:text-4xl">{page.title}</h1>
        </header>
      ) : null}

      {blocks.length ? (
        <Blocks blocks={blocks} />
      ) : page.body ? (
        // The fallback template: a plain Markdown body when the editor has not composed
        // blocks yet. Same renderer as the blog, same safety guarantees.
        <Markdown source={page.body} />
      ) : (
        <div className="card p-6 text-sm leading-8 text-muted">هذه الصفحة قيد الإنشاء.</div>
      )}
    </div>
  );
}
