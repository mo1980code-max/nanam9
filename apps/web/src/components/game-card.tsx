/**
 * The game tile — the most repeated component on the site, so it is optimised first.
 *
 * · A plain <img> with width/height and `loading="lazy"` rather than next/image for
 *   the seeded art: those are local SVGs, and running an SVG through the image
 *   optimizer costs a server round-trip to produce the same bytes. Remote artwork
 *   (imported games) still benefits from next/image, which is why `remotePatterns`
 *   is configured — the choice is per-source, not ideological.
 * · `aspect-ratio` on the art reserves the box before the image arrives. Without it
 *   every tile pops taller on load and the page jumps: that is CLS, and it is the
 *   metric portals like this fail.
 * · The hover overlay is CSS-only. No JS listener per card — with 24 cards on screen
 *   that is 24 listeners doing nothing until a mouse moves.
 */

import Link from 'next/link';
import { mediaUrl, type GameCard as GameCardType } from '@/lib/api';

const nf = new Intl.NumberFormat('ar-EG', { notation: 'compact', maximumFractionDigits: 1 });

export function Stars({ value, count }: { value: number | null; count?: number }) {
  const rating = value ?? 0;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-bold text-star" title={count ? `${rating.toFixed(1)} من 5 (${count} تقييم)` : undefined}>
      <span aria-hidden>★</span>
      <span className="text-muted">{rating ? rating.toFixed(1) : '—'}</span>
    </span>
  );
}

export function GameCard({ game, priority = false }: { game: GameCardType; priority?: boolean }) {
  const art = mediaUrl(game.thumbnailUrl) ?? '/brand/og-default.svg';

  return (
    <Link href={`/game/${game.slug}`} className="tile group w-[10.5rem] shrink-0 sm:w-[12.5rem] md:w-auto">
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={art}
          alt={`صورة لعبة ${game.title}`}
          width={400}
          height={300}
          className="tile-art"
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
        />
        <span className="tile-overlay">
          <span className="btn btn-primary !py-2 !text-sm">
            <span aria-hidden>▶</span> العب الآن
          </span>
        </span>
        {game.featured && (
          <span className="absolute top-2 start-2 rounded-full bg-gradient-to-r from-brand to-accent px-2 py-0.5 text-[10px] font-black text-white shadow">
            مميزة
          </span>
        )}
        {game.premium && (
          <span className="absolute top-2 end-2 rounded-full bg-warning px-2 py-0.5 text-[10px] font-black text-black shadow">
            مميّزة
          </span>
        )}
      </div>
      <div className="p-3">
        <h3 className="mb-1 truncate text-sm font-bold text-ink" title={game.title}>
          {game.title}
        </h3>
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
          <span className="truncate">{game.categories?.[0]?.name ?? 'ألعاب'}</span>
          <span className="flex shrink-0 items-center gap-2">
            <Stars value={game.ratingAvg} />
            <span title={`${game.plays} عملية تشغيل`}>▶ {nf.format(game.plays)}</span>
          </span>
        </div>
      </div>
    </Link>
  );
}

export function GameGrid({ games, priorityFirst = false }: { games: GameCardType[]; priorityFirst?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
      {games.map((game, index) => (
        <GameCard key={game.id} game={game} priority={priorityFirst && index < 6} />
      ))}
    </div>
  );
}
