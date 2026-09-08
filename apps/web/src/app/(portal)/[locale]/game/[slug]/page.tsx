/**
 * /[locale]/game/[slug] — the game detail page. This is the page the whole portal exists to serve.
 *
 *  • The game runs in a sandboxed iframe that the visitor starts by clicking.
 *  • Everything above the fold is server-rendered HTML — a crawler that runs no
 *    JavaScript sees the complete page.
 *  • Structured data: VideoGame + BreadcrumbList JSON-LD.
 *  • BILINGUAL: the H1 shows the English title on /en (titleEn falls back to Arabic),
 *    labels come from the dictionary, and the hreflang cluster points Google at the
 *    sibling language for the same game — one game, two indexable URLs, zero duplicates.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { GameActions } from '@/components/game-actions';
import { GameCard, Stars } from '@/components/game-card';
import { GamePlayer } from '@/components/game-player';
import { breadcrumbJsonLd, gameJsonLd, getGame, mediaUrl, siteOrigin, siteUrl } from '@/lib/api';
import { dateLocale, isLocale, l, localeAlternates, n, nf, pick, t, type Locale } from '@/lib/i18n';

export const revalidate = 60;

type Params = { locale: string; slug: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { locale: raw, slug } = await params;
  const locale: Locale = isLocale(raw) ? raw : 'ar';
  const result = await getGame(slug, locale);
  if (!result) return { title: t(locale, 'game.notFound') };

  const game = result.game;
  const title = pick(locale, game.seo?.title || game.title, game.titleEn);
  // `game.description` arrives already locale-resolved from the API (?lang=en).
  // On /en it beats the curated Arabic SEO text — an English meta description
  // for an English page, falling back to the Arabic one when untranslated.
  const description =
    (locale === 'en' ? game.description?.slice(0, 200) : game.seo?.description) ||
    game.seo?.description ||
    game.description?.slice(0, 200) ||
    t(locale, 'game.defaultDescription', { title });
  const image = mediaUrl(game.bannerUrl || game.thumbnailUrl) ?? undefined;
  const pageTitle = t(locale, 'game.playFree', { title });

  return {
    title: pageTitle,
    description,
    alternates: localeAlternates(locale, `/game/${game.slug}`),
    keywords: game.tags?.map((tag) => tag.name),
    openGraph: {
      type: 'website',
      title: pageTitle,
      description,
      url: siteUrl(l(locale, `/game/${game.slug}`)),
      images: image ? [{ url: image, width: 1200, height: 630, alt: title }] : undefined,
    },
    twitter: { card: image ? 'summary_large_image' : 'summary', title: pageTitle, description },
  };
}

/** The API stores sizes in KiB; humans read MB/KB. */
function fileSize(locale: Locale, kb?: number | null): string | null {
  if (!kb || kb <= 0) return null;
  if (kb < 1024) return `${n(locale, Math.round(kb))} ${t(locale, 'game.sizeKb')}`;
  return `${nf(locale).format(Number((kb / 1024).toFixed(1)))} ${t(locale, 'game.sizeMb')}`;
}

export default async function GamePage({ params }: { params: Promise<Params> }) {
  const { locale: raw, slug } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

  const result = await getGame(slug, locale);
  if (!result) notFound();

  const { game, related = [], trail = [], viewer } = result;
  const title = pick(locale, game.title, game.titleEn);
  const description = game.description?.trim();
  const instructions = game.instructions?.trim();
  const categories = game.categories ?? [];
  const tags = game.tags ?? [];
  const size = fileSize(locale, game.sizeKb);
  const playerSrc = mediaUrl(game.url);
  const ORIENTATION_LABELS: Record<string, string> = {
    portrait: t(locale, 'game.o.portrait'),
    landscape: t(locale, 'game.o.landscape'),
    both: t(locale, 'game.o.both'),
  };

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-4 sm:py-6">
      {/* Structured data: VideoGame (rich results) + the breadcrumb trail. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(gameJsonLd(game, siteOrigin())) }} />
      {trail.length > 1 ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd(trail, siteOrigin())) }} />
      ) : null}

      <Breadcrumbs trail={trail} locale={locale} />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <main>
          {/* ------------------------------------------------------------------ player */}
          <div className="mb-5">
            {playerSrc ? (
              <GamePlayer
                slug={game.slug}
                title={title}
                src={playerSrc}
                width={game.width}
                height={game.height}
                orientation={game.orientation}
                poster={mediaUrl(game.bannerUrl || game.thumbnailUrl)}
                locale={locale}
              />
            ) : (
              <div className="card grid aspect-video place-items-center text-sm text-muted">{t(locale, 'game.unavailable')}</div>
            )}
          </div>

          {/* ---------------------------------------------------------- title + actions */}
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl font-black leading-tight text-ink sm:text-3xl">{title}</h1>
              {locale === 'ar' && game.titleEn && game.titleEn !== game.title ? (
                <p dir="ltr" className="mt-1 text-start text-sm text-muted">{game.titleEn}</p>
              ) : null}
              {locale === 'en' && game.title !== game.titleEn && game.title ? (
                <p dir="rtl" className="mt-1 text-start text-sm text-muted">{game.title}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
                {game.ratingCount > 0 ? (
                  <span className="flex items-center gap-1.5">
                    <Stars value={game.ratingAvg} locale={locale} />
                    <b className="text-ink">{(game.ratingAvg ?? 0).toFixed(1)}</b>
                    <span>({n(locale, game.ratingCount)} {t(locale, 'game.ratingsCount')})</span>
                  </span>
                ) : (
                  <span>{t(locale, 'game.noRatings')}</span>
                )}
                <span className="flex items-center gap-1">
                  <span aria-hidden>▶</span>
                  {n(locale, game.plays)} {t(locale, 'unit.plays')}
                </span>
                {game.publishedAt ? (
                  <time dateTime={game.publishedAt}>
                    {new Date(game.publishedAt).toLocaleDateString(dateLocale(locale), { year: 'numeric', month: 'long', day: 'numeric' })}
                  </time>
                ) : null}
              </div>
            </div>

            {categories.length ? (
              <div className="flex flex-wrap gap-2">
                {categories.map((category) => (
                  <Link key={category.slug} href={l(locale, `/category/${category.slug}`)} className="chip chip-active">
                    {pick(locale, category.name, category.nameEn)}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>

          <div className="mb-6">
            <GameActions game={game} viewer={viewer} locale={locale} />
          </div>

          {/* ------------------------------------------------- description / how to play */}
          {(description || instructions) && (
            <div className="mb-6 grid gap-4 lg:grid-cols-2">
              {description ? (
                <section className="card p-5">
                  <h2 className="mb-2 text-base font-black text-ink">{t(locale, 'game.about')}</h2>
                  <p className="whitespace-pre-line text-sm leading-8 text-muted">{description}</p>
                </section>
              ) : null}
              {instructions ? (
                <section className="card p-5">
                  <h2 className="mb-2 text-base font-black text-ink">{t(locale, 'game.howTo')}</h2>
                  <p className="whitespace-pre-line text-sm leading-8 text-muted">{instructions}</p>
                </section>
              ) : null}
            </div>
          )}

          {/* ------------------------------------------------------------------- related */}
          {related.length ? (
            <section className="mb-6" aria-labelledby="related-heading">
              <h2 id="related-heading" className="mb-3 text-xl font-black text-ink">{t(locale, 'game.related')}</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {related.map((relatedGame) => (
                  <GameCard key={relatedGame.id} game={relatedGame} locale={locale} />
                ))}
              </div>
            </section>
          ) : null}

        </main>

        {/* --------------------------------------------------------------------- sidebar */}
        <aside className="grid gap-4 lg:sticky lg:top-24">
          <section className="card p-5" aria-labelledby="facts-heading">
            <h2 id="facts-heading" className="mb-3 text-base font-black text-ink">{t(locale, 'game.facts')}</h2>
            <dl className="grid gap-2 text-sm">
              <Row label={t(locale, 'game.f.categories')} value={categories.length ? categories.map((category) => pick(locale, category.name, category.nameEn)).join(locale === 'ar' ? '، ' : ', ') : '—'} />
              {game.developer ? <Row label={t(locale, 'game.f.developer')} value={game.developer} /> : null}
              {game.releaseYear ? <Row label={t(locale, 'game.f.releaseYear')} value={n(locale, game.releaseYear)} /> : null}
              {game.version ? <Row label={t(locale, 'game.f.version')} value={game.version} /> : null}
              {size ? <Row label={t(locale, 'game.f.size')} value={size} /> : null}
              {game.orientation ? <Row label={t(locale, 'game.f.orientation')} value={ORIENTATION_LABELS[game.orientation] ?? game.orientation} /> : null}
              {game.ageRating ? <Row label={t(locale, 'game.f.ageRating')} value={game.ageRating} /> : null}
              <Row label={t(locale, 'game.f.plays')} value={n(locale, game.plays)} />
              <Row label={t(locale, 'game.f.uniquePlays')} value={n(locale, game.uniquePlays)} />
              <Row label={t(locale, 'game.f.likes')} value={`${n(locale, game.likesCount)} 👍 / ${n(locale, game.dislikesCount)} 👎`} />
              <Row label={t(locale, 'game.f.favorites')} value={n(locale, game.favoritesCount)} />
            </dl>
          </section>

          {tags.length ? (
            <section className="card p-5">
              <h2 className="mb-3 text-base font-black text-ink">{t(locale, 'game.tags')}</h2>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <Link key={tag.slug} href={l(locale, `/games?tag=${encodeURIComponent(tag.slug)}`)} className="chip">
                    <span aria-hidden>#</span>
                    {tag.name}
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          <section className="card bg-gradient-to-br from-brand-soft to-transparent p-5">
            <h2 className="mb-2 text-base font-black text-ink">{t(locale, 'game.tryNew')}</h2>
            <p className="mb-4 text-sm leading-7 text-muted">{t(locale, 'game.tryNewBody')}</p>
            <div className="flex flex-wrap gap-2">
              <Link href={l(locale, '/games?sort=random')} className="btn btn-primary">{t(locale, 'game.random')}</Link>
              <Link href={l(locale, '/games')} className="btn btn-ghost">{t(locale, 'nav.allGames')}</Link>
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
