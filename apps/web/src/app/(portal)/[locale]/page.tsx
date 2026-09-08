/**
 * The homepage — in both languages.
 *
 * It renders whatever the admin's section builder produced, in order. `revalidate = 30`
 * makes it ISR: the first request after 30 seconds pays for a fresh render and everyone
 * else gets the cached HTML. With the [locale] segment there are exactly two cached
 * documents (ar and en) per window — still one database hit per half-minute each, and
 * `generateStaticParams` in the layout pre-builds both shells at deploy time.
 */

import { notFound } from 'next/navigation';
import { Sections } from '@/components/sections';
import { getSections, listGames, type Section } from '@/lib/api';
import { isLocale, t, type Locale } from '@/lib/i18n';

export const revalidate = 30;

type Params = { locale: string };

/**
 * A usable homepage even when the sections table is empty (a fresh install, or a
 * database that has not been seeded yet). Falling back beats rendering a blank page.
 */
function fallbackSections(): Section[] {
  return [
    {
      id: 'fallback-hero',
      page: 'home',
      kind: 'hero',
      title: 'العب فورًا — بلا تحميل ولا تسجيل',
      titleEn: 'Play instantly — no download, no sign-up',
      subtitle: 'ألعاب HTML5 تعمل في متصفحك مباشرة، على الجوال والحاسوب، وبأعلى أداء ممكن.',
      config: { source: 'featured', limit: 6 },
      sortOrder: 0,
      isVisible: true,
    },
    {
      id: 'fallback-popular',
      page: 'home',
      kind: 'carousel',
      title: 'الأكثر لعبًا',
      titleEn: 'Most played',
      subtitle: null,
      config: { source: 'popular', limit: 12 },
      sortOrder: 1,
      isVisible: true,
    },
    {
      id: 'fallback-categories',
      page: 'home',
      kind: 'category_grid',
      title: 'تصفّح التصنيفات',
      titleEn: 'Browse categories',
      subtitle: null,
      config: { limit: 10 },
      sortOrder: 2,
      isVisible: true,
    },
    {
      id: 'fallback-new',
      page: 'home',
      kind: 'game_grid',
      title: 'أضيف حديثًا',
      titleEn: 'New releases',
      subtitle: null,
      config: { source: 'newest', limit: 12 },
      sortOrder: 3,
      isVisible: true,
    },
  ];
}

export default async function HomePage({ params }: { params: Promise<Params> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

  const sections = await getSections('home');
  const visible = sections.filter((section) => section.isVisible);

  if (!visible.length) {
    const { items } = await listGames({ perPage: 6, sort: 'popular' });
    if (!items.length) {
      return (
        <div className="mx-auto w-full max-w-3xl px-4 py-24 text-center">
          <p className="mb-2 text-5xl" aria-hidden>🎮</p>
          <h1 className="mb-3 text-2xl font-black text-ink">{t(locale, 'home.emptyTitle')}</h1>
          <p className="text-sm leading-8 text-muted">{t(locale, 'home.emptyBody')}</p>
        </div>
      );
    }
  }

  return <Sections sections={visible.length ? visible : fallbackSections()} locale={locale} />;
}
