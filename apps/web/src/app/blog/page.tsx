/**
 * /blog — the editorial index.
 *
 * A games portal that only lists games competes on price with everyone else. Articles
 * are what earn the long-tail traffic and the internal links that spread authority
 * across the catalogue. The newest post gets a lead placement; the rest sit in a grid.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { Pagination } from '@/components/pagination';
import { getBlogCategories, listPosts, mediaUrl, siteUrl } from '@/lib/api';

export const revalidate = 60;

type Query = { page?: string; category?: string };

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'المدونة',
    description: 'أخبار الألعاب، المراجعات، الأدلة والنصائح — من فريق التحرير.',
    alternates: { canonical: '/blog' },
    openGraph: {
      type: 'website',
      title: 'المدونة — بوابة ألعاب HTML5',
      description: 'أخبار ومراجعات وأدلة ألعاب HTML5.',
      url: siteUrl('/blog'),
    },
  };
}

export default async function BlogPage({ searchParams }: { searchParams: Promise<Query> }) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);

  const [posts, categories] = await Promise.all([
    listPosts({ page, perPage: 12, category: params.category || undefined, sort: 'newest' }),
    getBlogCategories(),
  ]);

  const [lead, ...rest] = posts.items;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <nav aria-label="مسار التنقل" className="mb-3 text-xs text-muted">
        <Link href="/" className="hover:text-brand">الرئيسية</Link>
        <span aria-hidden className="mx-1.5">/</span>
        <span className="font-bold text-ink">المدونة</span>
      </nav>

      <header className="mb-6">
        <h1 className="mb-2 text-2xl font-black text-ink sm:text-4xl">المدونة</h1>
        <p className="max-w-2xl text-sm leading-8 text-muted">
          مراجعات، أخبار، وأدلة عملية تختصر عليك ساعات البحث. كل مقال يكتبه فريق التحرير ويرتبط مباشرة بالألعاب المذكورة فيه.
        </p>
      </header>

      {categories.length ? (
        <div className="mb-6 flex flex-wrap gap-2">
          <Link href="/blog" className={`chip ${!params.category ? 'chip-active' : ''}`}>الكل</Link>
          {categories.map((category) => (
            <Link
              key={category.id}
              href={`/blog?category=${encodeURIComponent(category.slug)}`}
              className={`chip ${params.category === category.slug ? 'chip-active' : ''}`}
            >
              {category.name}
              <span className="text-[10px] opacity-70">{category.postsCount.toLocaleString('ar-EG')}</span>
            </Link>
          ))}
        </div>
      ) : null}

      {!posts.items.length ? (
        <div className="card grid place-items-center px-6 py-16 text-center">
          <p className="mb-3 text-4xl" aria-hidden>📝</p>
          <h2 className="mb-2 text-lg font-black text-ink">لا مقالات منشورة بعد</h2>
          <p className="text-sm text-muted">ستظهر المقالات هنا فور نشرها من لوحة التحكم.</p>
        </div>
      ) : (
        <>
          {lead ? (
            <Link
              href={`/blog/${lead.slug}`}
              className="card group mb-6 grid overflow-hidden p-0 transition-all hover:-translate-y-0.5 hover:border-brand sm:grid-cols-[minmax(0,340px)_1fr]"
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-surface-2 sm:aspect-auto">
                {lead.coverImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={mediaUrl(lead.coverImage) ?? ''} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
                ) : (
                  <span aria-hidden className="grid h-full place-items-center text-5xl opacity-50">📰</span>
                )}
                <span className="absolute bottom-2 start-2 rounded-full bg-brand px-2.5 py-1 text-[10px] font-black text-white">الأحدث</span>
              </div>
              <div className="p-5 sm:p-6">
                {lead.category?.name ? <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-brand">{lead.category.name}</p> : null}
                <h2 className="mb-2 text-xl font-black text-ink group-hover:text-brand sm:text-2xl">{lead.title}</h2>
                {lead.excerpt ? <p className="mb-4 line-clamp-3 text-sm leading-8 text-muted">{lead.excerpt}</p> : null}
                <p className="text-xs text-muted">
                  {lead.author?.displayName ?? lead.author?.username ?? 'فريق التحرير'}
                  {lead.publishedAt ? ` • ${new Date(lead.publishedAt).toLocaleDateString('ar-EG')}` : ''}
                  {lead.readingMinutes ? ` • ${lead.readingMinutes.toLocaleString('ar-EG')} دقائق قراءة` : ''}
                </p>
              </div>
            </Link>
          ) : null}

          {rest.length ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {rest.map((post) => (
                <Link key={post.id} href={`/blog/${post.slug}`} className="card group grid overflow-hidden p-0 transition-all hover:-translate-y-0.5 hover:border-brand">
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
                      {post.publishedAt ? new Date(post.publishedAt).toLocaleDateString('ar-EG') : ''}
                      {post.readingMinutes ? ` • ${post.readingMinutes.toLocaleString('ar-EG')} د` : ''}
                      {post.views ? ` • ${post.views.toLocaleString('ar-EG')} مشاهدة` : ''}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          ) : null}

          <Pagination
            page={page}
            totalPages={posts.totalPages}
            hrefFor={(target) => `/blog?page=${target}${params.category ? `&category=${encodeURIComponent(params.category)}` : ''}`}
          />
        </>
      )}
    </div>
  );
}
