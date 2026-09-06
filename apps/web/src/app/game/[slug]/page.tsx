/**
 * /game/[slug] — the game detail page. This is the page the whole portal exists to serve.
 *
 * Decisions worth stating:
 *
 *  • The game runs in a sandboxed iframe that the visitor starts by clicking (see
 *    game-player.tsx). Loading a heavy game automatically would destroy the page's LCP
 *    and burn the visitor's data before they have decided to play.
 *
 *  • Everything above the fold is server-rendered HTML: title, description, stats,
 *    related games. A crawler that runs no JavaScript sees the complete page, which is
 *    the single biggest SEO difference against client-rendered competitor themes.
 *
 *  • Structured data is emitted as VideoGame + BreadcrumbList + (when ratings exist)
 *    AggregateRating. That is what produces star snippets in search results.
 *
 *  • Comments are NOT server-rendered here: the thread is fetched in the browser by the
 *    Comments component. Keeping the most volatile, most-personal content out of the
 *    rendered HTML is what lets this page stay an ISR document instead of a dynamic one.
 *
 *  • `generateStaticParams` pre-renders only the hottest games; the long tail is served
 *    by on-demand ISR. Pre-rendering all 20 000 would make every deploy take hours, and
 *    pre-rendering none would leave the popular pages slow on first hit.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { GameActions } from '@/components/game-actions';
import { GameCard, Stars } from '@/components/game-card';
import { GamePlayer } from '@/components/game-player';
import { breadcrumbJsonLd, gameJsonLd, getGame, listGames, mediaUrl, siteOrigin, siteUrl } from '@/lib/api';

export const revalidate = 60;

type Params = { slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const result = await getGame(slug);
  if (!result) return { title: 'اللعبة غير موجودة' };

  const game = result.game;
  const title = game.seo?.title || game.title;
  const description =
    game.seo?.description ||
    game.description?.slice(0, 200) ||
    `العب ${game.title} مجانًا على المتصفح، بلا تحميل ولا تسجيل.`;
  const canonical = `/game/${game.slug}`;
  const image = mediaUrl(game.bannerUrl || game.thumbnailUrl) ?? undefined;

  return {
    title: `العب ${title} مجانًا`,
    description,
    alternates: { canonical },
    keywords: game.tags?.map((tag) => tag.name),
    openGraph: {
      type: 'website',
      title: `العب ${title} مجانًا`,
      description,
      url: siteUrl(canonical),
      images: image ? [{ url: image, width: 1200, height: 630, alt: title }] : undefined,
    },
    twitter: { card: image ? 'summary_large_image' : 'summary', title: `العب ${title} مجانًا`, description },
  };
}

/** The API stores sizes in KiB; humans read MB/KB. */
function fileSize(kb?: number | null): string | null {
  if (!kb || kb <= 0) return null;
  if (kb < 1024) return `${Math.round(kb).toLocaleString('ar-EG')} ك.ب`;
  return `${(kb / 1024).toLocaleString('ar-EG', { maximumFractionDigits: 1 })} م.ب`;
}

const ORIENTATION_LABELS: Record<string, string> = {
  portrait: 'طولي (عمودي)',
  landscape: 'عرضي (أفقي)',
  both: 'الوضعان',
};

export default async function GamePage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const result = await getGame(slug);
  if (!result) notFound();

  const { game, related = [], trail = [], viewer } = result;
  const description = game.description?.trim();
  const instructions = game.instructions?.trim();
  const categories = game.categories ?? [];
  const tags = game.tags ?? [];
  const size = fileSize(game.sizeKb);
  const playerSrc = mediaUrl(game.url);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-4 sm:py-6">
      {/* Structured data: VideoGame (rich results) + the breadcrumb trail. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(gameJsonLd(game, siteOrigin())) }} />
      {trail.length > 1 ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd(trail, siteOrigin())) }} />
      ) : null}

      <Breadcrumbs trail={trail} />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <main>
          {/* ------------------------------------------------------------------ player */}
          <div className="mb-5">
            {playerSrc ? (
              <GamePlayer
                slug={game.slug}
                title={game.title}
                src={playerSrc}
                width={game.width}
                height={game.height}
                orientation={game.orientation}
                poster={mediaUrl(game.bannerUrl || game.thumbnailUrl)}
              />
            ) : (
              <div className="card grid aspect-video place-items-center text-sm text-muted">هذه اللعبة غير متاحة للتشغيل حاليًا.</div>
            )}
          </div>

          {/* ---------------------------------------------------------- title + actions */}
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl font-black leading-tight text-ink sm:text-3xl">{game.title}</h1>
              {game.titleEn && game.titleEn !== game.title ? (
                <p dir="ltr" className="mt-1 text-start text-sm text-muted">{game.titleEn}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
                {game.ratingCount > 0 ? (
                  <span className="flex items-center gap-1.5">
                    <Stars value={game.ratingAvg} />
                    <b className="text-ink">{(game.ratingAvg ?? 0).toFixed(1)}</b>
                    <span>({game.ratingCount.toLocaleString('ar-EG')} تقييم)</span>
                  </span>
                ) : (
                  <span>لا تقييمات بعد — كن الأول</span>
                )}
                <span className="flex items-center gap-1">
                  <span aria-hidden>▶</span>
                  {game.plays.toLocaleString('ar-EG')} مرة لعب
                </span>
                {game.publishedAt ? (
                  <time dateTime={game.publishedAt}>
                    {new Date(game.publishedAt).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' })}
                  </time>
                ) : null}
              </div>
            </div>

            {categories.length ? (
              <div className="flex flex-wrap gap-2">
                {categories.map((category) => (
                  <Link key={category.slug} href={`/category/${category.slug}`} className="chip chip-active">
                    {category.name}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>

          <div className="mb-6">
            <GameActions game={game} viewer={viewer} />
          </div>

          {/* ------------------------------------------------- description / how to play */}
          {(description || instructions) && (
            <div className="mb-6 grid gap-4 lg:grid-cols-2">
              {description ? (
                <section className="card p-5">
                  <h2 className="mb-2 text-base font-black text-ink">عن اللعبة</h2>
                  <p className="whitespace-pre-line text-sm leading-8 text-muted">{description}</p>
                </section>
              ) : null}
              {instructions ? (
                <section className="card p-5">
                  <h2 className="mb-2 text-base font-black text-ink">طريقة اللعب</h2>
                  <p className="whitespace-pre-line text-sm leading-8 text-muted">{instructions}</p>
                </section>
              ) : null}
            </div>
          )}

          {/* ------------------------------------------------------------------- related */}
          {related.length ? (
            <section className="mb-6" aria-labelledby="related-heading">
              <h2 id="related-heading" className="mb-3 text-xl font-black text-ink">ألعاب مشابهة</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {related.map((relatedGame) => (
                  <GameCard key={relatedGame.id} game={relatedGame} />
                ))}
              </div>
            </section>
          ) : null}

        </main>

        {/* --------------------------------------------------------------------- sidebar */}
        <aside className="grid gap-4 lg:sticky lg:top-24">
          <section className="card p-5" aria-labelledby="facts-heading">
            <h2 id="facts-heading" className="mb-3 text-base font-black text-ink">تفاصيل اللعبة</h2>
            <dl className="grid gap-2 text-sm">
              <Row label="التصنيفات" value={categories.length ? categories.map((category) => category.name).join('، ') : '—'} />
              {game.developer ? <Row label="المطوّر" value={game.developer} /> : null}
              {game.releaseYear ? <Row label="سنة الإصدار" value={game.releaseYear.toLocaleString('ar-EG')} /> : null}
              {game.version ? <Row label="الإصدار" value={game.version} /> : null}
              {size ? <Row label="الحجم" value={size} /> : null}
              {game.orientation ? <Row label="الاتجاه" value={ORIENTATION_LABELS[game.orientation] ?? game.orientation} /> : null}
              {game.ageRating ? <Row label="التصنيف العمري" value={game.ageRating} /> : null}
              <Row label="مرات اللعب" value={game.plays.toLocaleString('ar-EG')} />
              <Row label="لاعبون فريدون" value={game.uniquePlays.toLocaleString('ar-EG')} />
              <Row label="الإعجابات" value={`${game.likesCount.toLocaleString('ar-EG')} 👍 / ${game.dislikesCount.toLocaleString('ar-EG')} 👎`} />
              <Row label="المفضلة" value={game.favoritesCount.toLocaleString('ar-EG')} />
            </dl>
          </section>

          {tags.length ? (
            <section className="card p-5">
              <h2 className="mb-3 text-base font-black text-ink">وسوم</h2>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <Link key={tag.slug} href={`/games?tag=${encodeURIComponent(tag.slug)}`} className="chip">
                    <span aria-hidden>#</span>
                    {tag.name}
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          <section className="card bg-gradient-to-br from-brand-soft to-transparent p-5">
            <h2 className="mb-2 text-base font-black text-ink">جرّب شيئًا جديدًا</h2>
            <p className="mb-4 text-sm leading-7 text-muted">لا تعرف ما تلعب؟ اترك الحظ يختار لك لعبة من المكتبة.</p>
            <div className="flex flex-wrap gap-2">
              <Link href="/games?sort=random" className="btn btn-primary">لعبة عشوائية</Link>
              <Link href="/games" className="btn btn-ghost">كل الألعاب</Link>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] pb-2 last:border-0 last:pb-0">
      <dt className="shrink-0 text-xs font-bold text-muted">{label}</dt>
      <dd className="min-w-0 text-end text-xs font-bold text-ink">{value}</dd>
    </div>
  );
}
