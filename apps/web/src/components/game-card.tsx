/**
 * The game tile — the most repeated component on the site, so it is optimised first.
 *
 * · A plain <img> with width/height and `loading="lazy"` rather than next/image for
 *   the seeded art: those are local SVGs, and running an SVG through the image
 *   optimizer costs a server round-trip to produce the same bytes.
 * · `aspect-ratio` on the art reserves the box before the image arrives (CLS).
 * · The hover overlay is CSS-only. No JS listener per card.
 *
 * BILINGUAL: `locale` picks the title (titleEn falls back to title) and the number
 * format; the href carries the locale prefix.
 */

import Link from 'next/link';
import { mediaUrl, type GameCard as GameCardType } from '@/lib/api';
import { l, nfc, pick, t, type Locale } from '@/lib/i18n';

export function Stars({ value, count, locale = 'ar' }: { value: number | null; count?: number; locale?: Locale }) {
  const rating = value ?? 0;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-bold text-star"
      title={count ? t(locale, 'game.ratingTitle', { rating: rating.toFixed(1), count }) : undefined}
    >
      <span aria-hidden>★</span>
      <span className="text-muted">{rating ? rating.toFixed(1) : '—'}</span>
    </span>
  );
}

export function GameCard({ game, priority = false, locale = 'ar' }: { game: GameCardType; priority?: boolean; locale?: Locale }) {
  const art = mediaUrl(game.thumbnailUrl) ?? '/brand/og-default.svg';
  const title = pick(locale, game.title, game.titleEn);

  return (
    <Link href={l(locale, `/game/${game.slug}`)} className="tile group w-[10.5rem] shrink-0 sm:w-[12.5rem] md:w-auto">
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={art}
          alt={t(locale, 'game.artAlt', { title })}
          width={400}
          height={300}
          className="tile-art"
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
        />
        <span className="tile-overlay">
          <span className="btn btn-primary !py-2 !text-sm">
            <span aria-hidden>▶</span> {t(locale, 'game.playNow')}
          </span>
        </span>
        {game.featured && (
          <span className="absolute top-2 start-2 rounded-full bg-gradient-to-r from-brand to-accent px-2 py-0.5 text-[10px] font-black text-white shadow">
            {t(locale, 'game.featured')}
          </span>
        )}
        {game.premium && (
          <span className="absolute top-2 end-2 rounded-full bg-warning px-2 py-0.5 text-[10px] font-black text-black shadow">
            {t(locale, 'game.premium')}
          </span>
        )}
      </div>
      <div className="p-3">
        <h3 className="mb-1 truncate text-sm font-bold text-ink" title={title}>
          {title}
        </h3>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
          <span className="truncate">
            {game.categories?.[0] ? pick(locale, game.categories[0].name, game.categories[0].nameEn) : t(locale, 'sections.gamesFallback')}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <Stars value={game.ratingAvg} locale={locale} />
            <span title={t(locale, 'game.playsTitle', { count: game.plays })}>▶ {nfc(locale).format(game.plays)}</span>
          </span>
        </div>
      </div>
    </Link>
  );
}

export function GameGrid({ games, priorityFirst = false, locale = 'ar' }: { games: GameCardType[]; priorityFirst?: boolean; locale?: Locale }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
      {games.map((game, index) => (
        <GameCard key={game.id} game={game} priority={priorityFirst && index < 6} locale={locale} />
      ))}
    </div>
  );
}
