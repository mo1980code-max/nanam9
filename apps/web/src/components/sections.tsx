/**
 * The section renderer: turns the admin's drag-and-drop homepage into HTML.
 *
 * The homepage is not hardcoded. It is the ordered list of sections an editor built in
 * the admin panel (`/api/sections?page=home`), and this file is the switch that knows
 * how to draw each kind. That is what makes "rearrange the homepage" a publishing act
 * instead of a deploy — the specific thing the competing scripts cannot do without
 * editing PHP.
 *
 * WHY EACH SECTION IS AN ASYNC SERVER COMPONENT: every kind needs its own data
 * (featured games, top players, tags). Rendering them as sibling components lets React
 * fetch them concurrently instead of one after another, so a homepage with six sections
 * costs roughly the latency of its slowest query, not the sum.
 *
 * WHY `source` MAPS TO A SORT AND NOT TO A QUERY STRING: the admin stores an intent
 * ("featured", "popular", "trending"); the API validates a vocabulary (GAME_SORTS).
 * Translating here, in one place, is what stops an editor's typo from turning a
 * section into a 400 that renders as an empty rail.
 */

import Link from 'next/link';
import { Rail } from '@/components/rail';
import { GameCard, GameGrid, Stars } from '@/components/game-card';
import {
  getCategories,
  getLeaderboard,
  getTags,
  listGames,
  mediaUrl,
  type Category,
  type GameCard as GameCardType,
  type Section,
} from '@/lib/api';

const SORTS = ['newest', 'popular', 'top_rated', 'most_liked', 'trending', 'random', 'az', 'updated'];

type SourceQuery = { sort?: string; featured?: boolean; category?: string; limit: number };

/** Intent stored by the editor → a query the API will accept. */
function sourceQuery(config: Record<string, unknown>): SourceQuery {
  const source = String(config.source ?? 'popular');
  const limit = Math.max(1, Math.min(48, Number(config.limit ?? 12) || 12));
  const category = config.category ? String(config.category) : undefined;
  if (source === 'featured') return { featured: true, limit, category };
  return { sort: SORTS.includes(source) ? source : 'popular', limit, category };
}

async function gamesFor(config: Record<string, unknown>): Promise<GameCardType[]> {
  const query = sourceQuery(config);
  const result = await listGames({ perPage: query.limit, sort: query.sort, featured: query.featured, category: query.category });
  return result.items;
}

function SectionHeading({ title, subtitle, moreHref }: { title: string | null; subtitle?: string | null; moreHref?: string }) {
  if (!title) return null;
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 className="section-title text-balance text-ink">{title}</h2>
        {subtitle ? <p className="mt-1 truncate text-sm text-muted">{subtitle}</p> : null}
      </div>
      {moreHref ? (
        <Link href={moreHref} className="shrink-0 text-sm font-bold text-brand transition-opacity hover:opacity-80">
          عرض الكل ←
        </Link>
      ) : null}
    </div>
  );
}

/** The opening screen: one spotlight game plus the rest of the featured rail. */
async function Hero({ section }: { section: Section }) {
  const games = await gamesFor(section.config);
  const [spotlight, ...rest] = games;
  const art = spotlight ? mediaUrl(spotlight.thumbnailUrl) : null;

  return (
    <section className="mx-auto w-full max-w-7xl px-4 pt-6">
      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="relative overflow-hidden rounded-3xl border border-line bg-surface">
          {art ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={art} alt="" className="h-full max-h-[26rem] w-full object-cover" width={1200} height={600} fetchPriority="high" />
          ) : (
            <div className="h-64 bg-gradient-to-br from-brand-soft to-accent-soft" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 p-5 sm:p-7">
            <span className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[11px] font-black text-white backdrop-blur">
              <span aria-hidden>⚡</span> العب فورًا في متصفحك
            </span>
            <h1 className="mb-2 text-2xl font-black text-white text-balance sm:text-4xl">
              {section.title ?? 'ألعاب HTML5 بلا تحميل'}
            </h1>
            {section.subtitle ? <p className="mb-4 max-w-xl text-sm text-white/85 sm:text-base">{section.subtitle}</p> : null}
            <div className="flex flex-wrap items-center gap-2.5">
              {spotlight ? (
                <Link href={`/game/${spotlight.slug}`} className="btn btn-primary">
                  <span aria-hidden>▶</span> العب {spotlight.title}
                </Link>
              ) : null}
              <Link href="/games" className="btn border-white/25 bg-white/10 text-white backdrop-blur hover:bg-white/20">
                تصفّح كل الألعاب
              </Link>
            </div>
          </div>
        </div>

        <div className="card flex flex-col p-4">
          <h2 className="mb-3 text-sm font-black text-ink">الأكثر تشغيلًا الآن</h2>
          <ol className="grid gap-2">
            {(rest.length ? rest : games).slice(0, 5).map((game, index) => (
              <li key={game.id}>
                <Link href={`/game/${game.slug}`} className="flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-surface-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-sm font-black text-brand">
                    {(index + 1).toLocaleString('ar-EG')}
                  </span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={mediaUrl(game.thumbnailUrl) ?? '/brand/og-default.svg'}
                    alt=""
                    width={64}
                    height={48}
                    className="h-11 w-16 shrink-0 rounded-lg object-cover"
                    loading="lazy"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-ink">{game.title}</span>
                    <span className="block text-[11px] text-muted">
                      {game.categories?.[0]?.name ?? 'ألعاب'} · ▶ {game.plays.toLocaleString('ar-EG')}
                    </span>
                  </span>
                  <Stars value={game.ratingAvg} />
                </Link>
              </li>
            ))}
          </ol>
          <Link href="/games?sort=trending" className="btn btn-ghost mt-auto w-full">المزيد من الرائجة</Link>
        </div>
      </div>
    </section>
  );
}

async function CarouselSection({ section }: { section: Section }) {
  const games = await gamesFor(section.config);
  if (!games.length) return null;
  return (
    <section className="mx-auto w-full max-w-7xl px-4">
      <SectionHeading title={section.title} subtitle={section.subtitle} moreHref="/games?featured=true" />
      <Rail label={section.title ?? 'شريط ألعاب'}>
        {games.map((game, index) => (
          <li key={game.id} role="listitem">
            <GameCard game={game} priority={index < 4} />
          </li>
        ))}
      </Rail>
    </section>
  );
}

async function GridSection({ section, sort }: { section: Section; sort?: string }) {
  const games = await gamesFor(section.config);
  if (!games.length) return null;
  const query = sourceQuery(section.config);
  const more = query.category ? `/category/${query.category}` : `/games${sort ? `?sort=${sort}` : ''}`;
  return (
    <section className="mx-auto w-full max-w-7xl px-4">
      <SectionHeading title={section.title} subtitle={section.subtitle} moreHref={more} />
      <GameGrid games={games} />
    </section>
  );
}

async function CategoryGrid({ section }: { section: Section }) {
  const all = await getCategories();
  const limit = Math.max(1, Number(section.config.limit ?? 10) || 10);
  const categories: Category[] = all.slice(0, limit);
  if (!categories.length) return null;

  return (
    <section className="mx-auto w-full max-w-7xl px-4">
      <SectionHeading title={section.title} subtitle={section.subtitle} moreHref="/games" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {categories.map((category) => (
          <Link
            key={category.id}
            href={category.url || `/category/${category.slug}`}
            className="card group flex items-center gap-3 p-3.5 transition-all hover:-translate-y-0.5 hover:border-brand"
          >
            <span
              aria-hidden
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-xl transition-transform group-hover:scale-110"
              style={{ backgroundColor: `${category.color ?? '#7c3aed'}1f`, color: category.color ?? '#7c3aed' }}
            >
              {category.icon ?? '🎮'}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold text-ink">{category.name}</span>
              <span className="block text-[11px] text-muted">
                {category.gamesCount.toLocaleString('ar-EG')} لعبة
                {category.children?.length ? ` · ${category.children.length} فرعي` : ''}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

async function TagCloud({ section }: { section: Section }) {
  const limit = Math.max(1, Number(section.config.limit ?? 24) || 24);
  const tags = await getTags(limit);
  if (!tags.length) return null;
  return (
    <section className="mx-auto w-full max-w-7xl px-4">
      <SectionHeading title={section.title} subtitle={section.subtitle} />
      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <Link key={tag.slug} href={`/games?tag=${encodeURIComponent(tag.slug)}`} className="chip hover:-translate-y-0.5">
            <span aria-hidden>#</span>
            {tag.name}
            {typeof tag.count === 'number' ? <span className="text-[10px] opacity-70">{tag.count.toLocaleString('ar-EG')}</span> : null}
          </Link>
        ))}
      </div>
    </section>
  );
}

async function Leaderboard({ section }: { section: Section }) {
  const limit = Math.max(3, Math.min(20, Number(section.config.limit ?? 8) || 8));
  const rows = await getLeaderboard(limit);
  if (!rows.length) return null;
  const medals = ['🥇', '🥈', '🥉'];

  return (
    <section className="mx-auto w-full max-w-7xl px-4">
      <SectionHeading title={section.title} subtitle={section.subtitle} moreHref="/leaderboard" />
      <div className="card divide-y divide-[var(--border)] overflow-hidden">
        {rows.map((row) => (
          <Link key={row.username} href={row.url || `/u/${row.username}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
            <span className="w-7 shrink-0 text-center text-sm font-black text-muted">
              {row.rank <= 3 ? <span aria-hidden>{medals[row.rank - 1]}</span> : row.rank.toLocaleString('ar-EG')}
            </span>
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand to-accent text-sm font-black text-white">
              {(row.displayName ?? row.username).slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold text-ink">{row.displayName ?? row.username}</span>
              <span className="block text-[11px] text-muted">@{row.username}</span>
            </span>
            <span className="shrink-0 text-[11px] font-bold text-muted">
              {row.plays.toLocaleString('ar-EG')} لعبة
            </span>
            <span className="shrink-0 rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-black text-brand">
              {row.xp.toLocaleString('ar-EG')} نقطة
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function Banner({ section }: { section: Section }) {
  const config = section.config as { image?: string; url?: string; text?: string };
  const image = mediaUrl(config.image ?? null);
  const body = (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-gradient-to-r from-brand-soft to-accent-soft">
      {image ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={image} alt="" className="h-40 w-full object-cover sm:h-48" loading="lazy" />
      ) : null}
      <div className="p-5 text-center">
        <p className="text-lg font-black text-ink">{config.text ?? section.title ?? ''}</p>
        {section.subtitle ? <p className="mt-1 text-sm text-muted">{section.subtitle}</p> : null}
      </div>
    </div>
  );
  return (
    <section className="mx-auto w-full max-w-7xl px-4">
      {config.url ? (
        <Link href={config.url} className="block transition-transform hover:-translate-y-0.5">
          {body}
        </Link>
      ) : (
        body
      )}
    </section>
  );
}

/** One section, dispatched by kind. Unknown kinds render nothing rather than crashing
 *  the homepage: an editor who saves a block this build does not know yet should see a
 *  missing rail, not a 500 for every visitor. */
export async function SectionBlock({ section }: { section: Section }) {
  if (!section.isVisible) return null;

  switch (section.kind) {
    case 'hero':
      return <Hero section={section} />;
    case 'carousel':
      return <CarouselSection section={section} />;
    case 'category_grid':
      return <CategoryGrid section={section} />;
    case 'tag_cloud':
      return <TagCloud section={section} />;
    case 'leaderboard':
      return <Leaderboard section={section} />;
    case 'banner':
      return <Banner section={section} />;
    case 'html': {
      // Admin-authored markup (sections.manage). The API sanitises settings HTML on
      // write except under `integrations.`, which is the only place scripts are allowed.
      const html = String((section.config as { html?: string }).html ?? '');
      if (!html.trim()) return null;
      return (
        <section className="mx-auto w-full max-w-7xl px-4">
          <div className="card p-4" dangerouslySetInnerHTML={{ __html: html }} />
        </section>
      );
    }
    case 'popular':
      return <GridSection section={section} sort="popular" />;
    case 'recent':
      return <GridSection section={section} sort="newest" />;
    case 'game_grid':
    default:
      return <GridSection section={section} />;
  }
}

export function Sections({ sections }: { sections: Section[] }) {
  const visible = sections.filter((section) => section.isVisible);
  if (!visible.length) return null;
  return (
    <div className="grid gap-10 py-8">
      {visible.map((section) => (
        <SectionBlock key={section.id} section={section} />
      ))}
    </div>
  );
}
