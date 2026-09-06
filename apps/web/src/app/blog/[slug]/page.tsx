/**
 * /blog/[slug] — a single article.
 *
 * The body is Markdown that the API sanitised at write time, re-rendered here into React
 * elements (no dangerouslySetInnerHTML): a stored-XSS payload that slipped past one layer
 * still cannot execute, because the renderer only ever produces known-safe tags and drops
 * javascript: URLs. The BlogPosting JSON-LD comes from the API so author, dates and image
 * always match what is stored.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { Markdown } from '@/components/markdown';
import { getPost, listPosts, mediaUrl, siteUrl } from '@/lib/api';

export const revalidate = 60;

type Params = { slug: string };

export async function generateStaticParams() {
  // Pre-render the newest articles; older ones come from ISR on first request.
  const { items } = await listPosts({ perPage: 30, sort: 'newest' });
  return items.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return { title: 'المقال غير موجود' };

  const title = post.seo?.title || post.title;
  const description = post.seo?.description || post.excerpt || undefined;
  const canonical = `/blog/${post.slug}`;
  const image = mediaUrl(post.coverImage) ?? undefined;
  const noIndex = /noindex/i.test(post.seo?.robots ?? '');

  return {
    title,
    description,
    alternates: { canonical },
    keywords: post.tags?.map((tag) => tag.name),
    robots: noIndex ? { index: false, follow: false } : undefined,
    openGraph: {
      type: 'article',
      title,
      description,
      url: siteUrl(canonical),
      publishedTime: post.publishedAt ?? undefined,
      modifiedTime: post.updatedAt ?? undefined,
      authors: post.author?.displayName ? [post.author.displayName] : undefined,
      images: image ? [{ url: image, alt: title }] : undefined,
    },
    twitter: { card: image ? 'summary_large_image' : 'summary', title, description },
  };
}

export default async function BlogPostPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();

  const cover = mediaUrl(post.coverImage);
  const trail = [
    { name: 'الرئيسية', url: '/' },
    { name: 'المدونة', url: '/blog' },
    ...(post.category ? [{ name: post.category.name, url: `/blog?category=${encodeURIComponent(post.category.slug)}` }] : []),
    { name: post.title, url: `/blog/${post.slug}` },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      {(post.jsonLd ?? []).map((node, index) => (
        <script key={index} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(node) }} />
      ))}

      <Breadcrumbs trail={trail} />

      <article className="card overflow-hidden p-0">
        {cover ? (
          <div className="aspect-[16/9] w-full overflow-hidden bg-surface-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={cover} alt={post.title} className="h-full w-full object-cover" fetchPriority="high" />
          </div>
        ) : null}

        <div className="p-5 sm:p-8">
          {post.category ? (
            <Link href={`/blog?category=${encodeURIComponent(post.category.slug)}`} className="chip chip-active mb-3">
              {post.category.name}
            </Link>
          ) : null}
          <h1 className="mb-3 text-2xl font-black leading-snug text-ink sm:text-4xl">{post.title}</h1>
          <p className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="font-bold text-ink">{post.author?.displayName ?? post.author?.username ?? 'فريق التحرير'}</span>
            {post.publishedAt ? (
              <time dateTime={post.publishedAt}>
                {new Date(post.publishedAt).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' })}
              </time>
            ) : null}
            {post.readingMinutes ? <span>{post.readingMinutes.toLocaleString('ar-EG')} دقائق قراءة</span> : null}
            {post.views ? <span>{post.views.toLocaleString('ar-EG')} مشاهدة</span> : null}
          </p>

          {post.excerpt ? (
            <p className="mb-6 rounded-2xl border-s-4 border-brand bg-brand-soft p-4 text-sm leading-8 text-ink">{post.excerpt}</p>
          ) : null}

          <Markdown source={post.body ?? ''} />

          {post.tags?.length ? (
            <div className="mt-8 flex flex-wrap gap-1.5 border-t border-[var(--border)] pt-5">
              {post.tags.map((tag) => (
                <Link key={tag.slug} href={`/blog?tag=${encodeURIComponent(tag.slug)}`} className="chip">
                  <span aria-hidden>#</span>
                  {tag.name}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      </article>

      {post.related?.length ? (
        <section className="mt-6" aria-labelledby="related-posts">
          <h2 id="related-posts" className="mb-3 text-xl font-black text-ink">اقرأ أيضًا</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {post.related.map((related) => (
              <Link key={related.id} href={`/blog/${related.slug}`} className="card p-4 transition-all hover:-translate-y-0.5 hover:border-brand">
                <p className="mb-1 line-clamp-2 text-sm font-bold text-ink">{related.title}</p>
                {related.excerpt ? <p className="line-clamp-2 text-xs leading-6 text-muted">{related.excerpt}</p> : null}
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
