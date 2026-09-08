/**
 * /[locale]/blog — the editorial index.
 *
 * Articles earn the long-tail traffic and the internal links that spread authority
 * across the catalogue. Post bodies are written in one language (the editorial team's);
 * the chrome around them — headings, badges, dates, counters — is fully localized, and
 * dates render in the visitor's own calendar/number system.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pagination } from '@/components/pagination';
import { getBlogCategories, listPosts, mediaUrl, siteUrl } from '@/lib/api';
import { dateLocale, isLocale, l, localeAlternates, n, t, type Locale } from '@/lib/i18n';

export const revalidate = 60;

type Params = { locale: string };
type Query = { page?: string; category?: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { locale: raw } = await params;
  const locale: Locale = isLocale(raw) ? raw : 'ar';
  return {
    title: t(locale, 'blog.title'),
    description: t(locale, 'blog.description'),
    alternates: localeAlternates(locale, '/blog'),
    openGraph: {
      type: 'website',
      title: `${t(locale, 'blog.title')} — Voltade`,
      description: t(locale, 'blog.description'),
      url: siteUrl(l(locale, '/blog')),
    },
  };
}

export default async function BlogPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Query>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

  const query = await searchParams;
  const page = Math.max(1, Number(query.page) || 1);

  const [posts, categories] = await Promise.all([
    listPosts({ page, perPage: 12, category: query.category || undefined, sort: 'newest' }),
    getBlogCategories(),
  ]);

  const [lead, ...rest] = posts.items;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <nav aria-label={t(locale, 'crumbs.aria')} className="mb-3 text-xs text-muted">
        <Link href={l(locale, '/')} className="hover:text-brand">{t(locale, 'crumbs.home')}</Link>
        <span aria-hidden className="mx-1.5">/</span>
        <span className="font-bold text-ink">{t(locale, 'blog.title')}</span>
      </nav>

      <header className="mb-6">
        <h1 className="mb-2 text-2xl font-black text-ink sm:text-4xl">{t(locale, 'blog.title')}</h1>
        <p className="max-w-2xl text-sm leading-8 text-muted">{t(locale, 'blog.intro')}</p>
      </header>

      {categories.length ? (
        <div className="mb-6 flex flex-wrap gap-2">
          <Link href={l(locale, '/blog')} className={`chip ${!query.category ? 'chip-active' : ''}`}>{t(locale, 'blog.all')}</Link>
          {categories.map((category) => (
            <Link
              key={category.id}
              href={l(locale, `/blog?category=${encodeURIComponent(category.slug)}`)}
              className={`chip ${query.category === category.slug ? 'chip-active' : ''}`}
            >
              {category.name}
              <span className="text-[10px] opacity-70">{n(locale, category.postsCount)}</span>
            </Link>
          ))}
        </div>
      ) : null}

      {!posts.items.length ? (
        <div className="card grid place-items-center px-6 py-16 text-center">
          <p className="mb-3 text-4xl" aria-hidden>📝</p>
          <h2 className="mb-2 text-lg font-black text-ink">{t(locale, 'blog.emptyTitle')}</h2>
          <p className="text-sm text-muted">{t(locale, 'blog.emptyBody')}</p>
        </div>
      ) : (
        <>
          {lead ? (
            <Link
              href={l(locale, `/blog/${lead.slug}`)}
              className="card group mb-6 grid overflow-hidden p-0 transition-all hover:-translate-y-0.5 hover:border-brand sm:grid-cols-[minmax(0,340px)_1fr]"
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-surface-2 sm:aspect-auto">
                {lead.coverImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={mediaUrl(lead.coverImage) ?? ''} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
                ) : (
                  <span aria-hidden className="grid h-full place-items-center text-5xl opacity-50">📰</span>
                )}
                <span className="absolute bottom-2 start-2 rounded-full bg-brand px-2.5 py-1 text-[10px] font-black text-white">{t(locale, 'blog.latest')}</span>
              </div>
              <div className="p-5 sm:p-6">
                {lead.category?.name ? <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-brand">{lead.category.name}</p> : null}
                <h2 className="mb-2 text-xl font-black text-ink group-hover:text-brand sm:text-2xl">{lead.title}</h2>
                {lead.excerpt ? <p className="mb-4 line-clamp-3 text-sm leading-8 text-muted">{lead.excerpt}</p> : null}
                <p className="text-xs text-muted">
                  {lead.author?.displayName ?? lead.author?.username ?? t(locale, 'blog.editorial')}
                  {lead.publishedAt ? ` • ${new Date(lead.publishedAt).toLocaleDateString(dateLocale(locale))}` : ''}
                  {lead.readingMinutes ? ` • ${n(locale, lead.readingMinutes)} ${t(locale, 'unit.minutesRead')}` : ''}
                </p>
              </div>
            </Link>
          ) : null}

          {rest.length ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {rest.map((post) => (
                <Link key={post.id} href={l(locale, `/blog/${post.slug}`)} className="card group grid overflow-hidden p-0 transition-all hover:-translate-y-0.5 hover:border-brand">
                  <div className="aspect-[16/9] overflow-hidden bg-surface-2">
                    {post.coverImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={mediaUrl(post.coverImage) ?? ''} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
                    ) : (
                      <span aria-hidden className="grid h-full place-items-center text-4xl opacity-40">📄</span>
                    )}
                  </div>
                  <div className="grid gap-2 p-4">
                    {post.category?.name ? <p className="text-[11px] font-black uppercase tracking-wider text-brand">{post.category.name}</p> : null}
                    <h2 className="line-clamp-2 text-base font-bold leading-7 text-ink group-hover:text-brand">{post.title}</h2>
                    <p className="line-clamp-2 text-sm leading-7 text-muted">{post.excerpt ?? ''}</p>
                    <p className="text-[11px] text-muted">
                      {post.publishedAt ? new Date(post.publishedAt).toLocaleDateString(dateLocale(locale)) : ''}
                      {post.readingMinutes ? ` • ${n(locale, post.readingMinutes)} ${t(locale, 'unit.minutesShort')}` : ''}
                      {post.views ? ` • ${n(locale, post.views)} ${t(locale, 'unit.views')}` : ''}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          ) : null}

          <Pagination
            page={page}
            totalPages={posts.totalPages}
            hrefFor={(target) => l(locale, `/blog?page=${target}${query.category ? `&category=${encodeURIComponent(query.category)}` : ''}`)}
            locale={locale}
          />
        </>
      )}
    </div>
  );
}
