/**
 * The page-builder renderer: one function per block type.
 *
 * The vocabulary lives in @voltade/shared (PAGE_BLOCK_TYPES) and the API refuses to
 * store a type that is not in it, so this switch cannot be handed something it has
 * never seen — except by an old row surviving a code rollback, which is why the default
 * case renders nothing instead of throwing.
 *
 * Blocks are *data*: an editor rearranging the "About us" page is publishing, not
 * deploying. That is the feature the fixed-template competitors do not have.
 */

import Link from 'next/link';
import { Markdown } from '@/components/markdown';
import { GameGrid } from '@/components/game-card';
import { Rail } from '@/components/rail';
import { GameCard } from '@/components/game-card';
import { getCategories, getLeaderboard, getTags, listGames, mediaUrl, type PageBlock } from '@/lib/api';

const str = (props: Record<string, unknown>, key: string): string => String(props[key] ?? '');
const num = (props: Record<string, unknown>, key: string, fallback: number): number => {
  const value = Number(props[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

async function Block({ block }: { block: PageBlock }) {
  const props = block.props ?? {};

  switch (block.type) {
    case 'hero':
      return (
        <section className="relative overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-brand-soft via-surface to-accent-soft p-7 sm:p-12">
          <h1 className="mb-3 text-3xl font-black text-balance text-ink sm:text-5xl">{str(props, 'title')}</h1>
          {str(props, 'subtitle') ? <p className="mb-6 max-w-2xl text-base leading-8 text-muted sm:text-lg">{str(props, 'subtitle')}</p> : null}
          <div className="flex flex-wrap gap-2.5">
            {str(props, 'ctaText') ? (
              <Link href={str(props, 'ctaUrl') || '/games'} className="btn btn-primary">
                {str(props, 'ctaText')}
              </Link>
            ) : null}
            {str(props, 'secondaryText') ? (
              <Link href={str(props, 'secondaryUrl') || '/blog'} className="btn btn-ghost">
                {str(props, 'secondaryText')}
              </Link>
            ) : null}
          </div>
        </section>
      );

    case 'rich_text':
    case 'text':
      return <Markdown source={str(props, 'markdown') || str(props, 'text')} />;

    case 'stat_row': {
      const stats = Array.isArray(props.stats) ? (props.stats as { label?: unknown; value?: unknown }[]) : [];
      if (!stats.length) return null;
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((stat, index) => (
            <div key={index} className="card p-4 text-center">
              <p className="text-2xl font-black text-brand">{String(stat.value ?? '')}</p>
              <p className="mt-1 text-xs font-bold text-muted">{String(stat.label ?? '')}</p>
            </div>
          ))}
        </div>
      );
    }

    case 'faq': {
      const items = Array.isArray(props.items) ? (props.items as { q?: unknown; a?: unknown }[]) : [];
      if (!items.length) return null;
      return (
        <div className="grid gap-2">
          {items.map((item, index) => (
            <details key={index} className="card group p-4 open:border-brand">
              <summary className="cursor-pointer list-none text-sm font-black text-ink marker:hidden">
                <span className="ms-1">{String(item.q ?? '')}</span>
                <span aria-hidden className="float-start text-brand transition-transform group-open:rotate-45">＋</span>
              </summary>
              <p className="mt-3 text-sm leading-8 text-muted">{String(item.a ?? '')}</p>
            </details>
          ))}
        </div>
      );
    }

    case 'cta':
      return (
        <section className="card flex flex-col items-center gap-3 p-7 text-center sm:flex-row sm:justify-between sm:text-start">
          <div>
            <h2 className="text-xl font-black text-ink">{str(props, 'title')}</h2>
            {str(props, 'subtitle') ? <p className="mt-1 text-sm text-muted">{str(props, 'subtitle')}</p> : null}
          </div>
          {str(props, 'text') || str(props, 'ctaText') ? (
            <Link href={str(props, 'url') || '/games'} className="btn btn-primary shrink-0">
              {str(props, 'text') || str(props, 'ctaText')}
            </Link>
          ) : null}
        </section>
      );

    case 'image': {
      const src = mediaUrl(str(props, 'src') || str(props, 'image'));
      if (!src) return null;
      return (
        <figure className="overflow-hidden rounded-2xl border border-line">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={str(props, 'alt')} className="w-full object-cover" loading="lazy" />
          {str(props, 'caption') ? <figcaption className="bg-surface-2 px-4 py-2 text-xs text-muted">{str(props, 'caption')}</figcaption> : null}
        </figure>
      );
    }

    case 'spacer':
      return <div style={{ height: `${num(props, 'height', 32)}px` }} />;

    case 'html':
      // Sanitised by the API on write (scripts and handlers removed). An operator who
      // needs to execute code uses `integrations.headHtml`, which is audited separately.
      return <div className="card p-4" dangerouslySetInnerHTML={{ __html: str(props, 'html') }} />;

    case 'banner':
      return (
        <Link href={str(props, 'url') || '#'} className="block overflow-hidden rounded-2xl border border-line bg-gradient-to-r from-brand-soft to-accent-soft p-6 text-center transition-transform hover:-translate-y-0.5">
          <p className="text-lg font-black text-ink">{str(props, 'title') || str(props, 'text')}</p>
          {str(props, 'subtitle') ? <p className="mt-1 text-sm text-muted">{str(props, 'subtitle')}</p> : null}
        </Link>
      );

    case 'category_grid': {
      const categories = (await getCategories()).slice(0, num(props, 'limit', 10));
      if (!categories.length) return null;
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {categories.map((category) => (
            <Link key={category.id} href={category.url || `/category/${category.slug}`} className="card flex items-center gap-3 p-3.5 transition-all hover:-translate-y-0.5 hover:border-brand">
              <span aria-hidden className="grid h-10 w-10 place-items-center rounded-xl text-lg" style={{ backgroundColor: `${category.color ?? '#7c3aed'}1f` }}>
                {category.icon ?? '🎮'}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-ink">{category.name}</span>
                <span className="block text-[11px] text-muted">{category.gamesCount} لعبة</span>
              </span>
            </Link>
          ))}
        </div>
      );
    }

    case 'tag_cloud': {
      const tags = await getTags(num(props, 'limit', 24));
      if (!tags.length) return null;
      return (
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <Link key={tag.slug} href={`/games?tag=${encodeURIComponent(tag.slug)}`} className="chip">
              <span aria-hidden>#</span>
              {tag.name}
            </Link>
          ))}
        </div>
      );
    }

    case 'leaderboard': {
      const rows = await getLeaderboard(num(props, 'limit', 8));
      if (!rows.length) return null;
      return (
        <div className="card divide-y divide-[var(--border)] overflow-hidden">
          {rows.map((row) => (
            <Link key={row.username} href={row.url || `/u/${row.username}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
              <span className="w-6 text-center text-sm font-black text-muted">{row.rank.toLocaleString('ar-EG')}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-bold text-ink">{row.displayName ?? row.username}</span>
              <span className="rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-black text-brand">{row.xp.toLocaleString('ar-EG')} نقطة</span>
            </Link>
          ))}
        </div>
      );
    }

    case 'game_grid':
    case 'popular':
    case 'recent':
    case 'carousel': {
      const sort = block.type === 'recent' ? 'newest' : block.type === 'popular' ? 'popular' : str(props, 'sort') || 'newest';
      const category = str(props, 'category') || undefined;
      const featured = str(props, 'source') === 'featured' || props.featured === true ? true : undefined;
      const limit = num(props, 'limit', 12);
      const { items } = await listGames({ perPage: limit, sort, category, featured });
      if (!items.length) return null;
      if (block.type === 'carousel') {
        return (
          <Rail label={str(props, 'title') || 'ألعاب'}>
            {items.map((game) => (
              <li key={game.id} role="listitem">
                <GameCard game={game} />
              </li>
            ))}
          </Rail>
        );
      }
      return <GameGrid games={items} />;
    }

    default:
      return null;
  }
}

export function Blocks({ blocks }: { blocks: PageBlock[] }) {
  if (!blocks?.length) return null;
  return (
    <div className="grid gap-8">
      {blocks.map((block) => (
        <Block key={block.id} block={block} />
      ))}
    </div>
  );
}
