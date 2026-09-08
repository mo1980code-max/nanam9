/**
 * /[locale]/blog/[slug] — a single article.
 *
 * The body is Markdown that the API sanitised at write time, re-rendered here into React
 * elements (no dangerouslySetInnerHTML). The BlogPosting JSON-LD comes from the API so
 * author, dates and image always match what is stored. Chrome is localized; the prose
 * itself renders with the locale's typography (prose-ar / prose-en).
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { Markdown } from '@/components/markdown';
import { getPost, mediaUrl, siteUrl } from '@/lib/api';
import { dateLocale, isLocale, l, localeAlternates, n, t, type Locale } from '@/lib/i18n';

export const revalidate = 60;

type Params = { locale: string; slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { locale: raw, slug } = await params;
  const locale: Locale = isLocale(raw) ? raw : 'ar';
  const post = await getPost(slug);
  if (!post) return { title: t(locale, 'blog.notFound') };

  const title = post.seo?.title || post.title;
  const description = post.seo?.description || post.excerpt || undefined;
  const image = mediaUrl(post.coverImage) ?? undefined;
  const noIndex = /noindex/i.test(post.seo?.robots ?? '');

  return {
    title,
    description,
    alternates: localeAlternates(locale, `/blog/${post.slug}`),
    keywords: post.tags?.map((tag) => tag.name),
    robots: noIndex ? { index: false, follow: false } : undefined,
    openGraph: {
      type: 'article',
      title,
      description,
      url: siteUrl(l(locale, `/blog/${post.slug}`)),
      publishedTime: post.publishedAt ?? undefined,
      modifiedTime: post.updatedAt ?? undefined,
      authors: post.author?.displayName ? [post.author.displayName] : undefined,
      images: image ? [{ url: image, alt: title }] : undefined,
    },
    twitter: { card: image ? 'summary_large_image' : 'summary', title, description },
  };
}

export default async function BlogPostPage({ params }: { params: Promise<Params> }) {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

  const post = await getPost(slug);
  if (!post) notFound();

  const cover = mediaUrl(post.coverImage);
  const trail = [
    { name: t(locale, 'crumbs.home'), url: '/' },
    { name: t(locale, 'blog.title'), url: '/blog' },
    ...(post.category ? [{ name: post.category.name, url: `/blog?category=${encodeURIComponent(post.category.slug)}` }] : []),
    { name: post.title, url: `/blog/${post.slug}` },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      {(post.jsonLd ?? []).map((node, index) => (
        <script key={index} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(node) }} />
      ))}

      <Breadcrumbs trail={trail} locale={locale} />

      <article className="card overflow-hidden p-0">
        {cover ? (
          <div className="aspect-[16/9] w-full overflow-hidden bg-surface-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={cover} alt={post.title} className="h-full w-full object-cover" fetchPriority="high" />
          </div>
        ) : null}

        <div className="p-5 sm:p-8">
          {post.category ? (
            <Link href={l(locale, `/blog?category=${encodeURIComponent(post.category.slug)}`)} className="chip chip-active mb-3">
              {post.category.name}
            </Link>
          ) : null}
          <h1 className="mb-3 text-2xl font-black leading-snug text-ink sm:text-4xl">{post.title}</h1>
          <p className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="font-bold text-ink">{post.author?.displayName ?? post.author?.username ?? t(locale, 'blog.editorial')}</span>
            {post.publishedAt ? (
              <time dateTime={post.publishedAt}>
                {new Date(post.publishedAt).toLocaleDateString(dateLocale(locale), { year: 'numeric', month: 'long', day: 'numeric' })}
              </time>
            ) : null}
            {post.readingMinutes ? <span>{n(locale, post.readingMinutes)} {t(locale, 'unit.minutesRead')}</span> : null}
            {post.views ? <span>{n(locale, post.views)} {t(locale, 'unit.views')}</span> : null}
          </p>

          {post.excerpt ? (
            <p className="mb-6 rounded-2xl border-s-4 border-brand bg-brand-soft p-4 text-sm leading-8 text-ink">{post.excerpt}</p>
          ) : null}

          <Markdown source={post.body ?? ''} locale={locale} />

          {post.tags?.length ? (
            <div className="mt-8 flex flex-wrap gap-1.5 border-t border-[var(--border)] pt-5">
              {post.tags.map((tag) => (
                <Link key={tag.slug} href={l(locale, `/blog?tag=${encodeURIComponent(tag.slug)}`)} className="chip">
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
          <h2 id="related-posts" className="mb-3 text-xl font-black text-ink">{t(locale, 'blog.readAlso')}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {post.related.map((related) => (
              <Link key={related.id} href={l(locale, `/blog/${related.slug}`)} className="card p-4 transition-all hover:-translate-y-0.5 hover:border-brand">
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
