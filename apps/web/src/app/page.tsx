/**
 * The homepage.
 *
 * It renders whatever the admin's section builder produced, in order. `revalidate = 30`
 * makes it ISR: the first request after 30 seconds pays for a fresh render and everyone
 * else gets the cached HTML from the edge. For a portal whose homepage is the same for
 * every visitor, that is the difference between a database query per hit and one per
 * half-minute.
 */

import { Sections } from '@/components/sections';
import { getSections, listGames, type Section } from '@/lib/api';

export const revalidate = 30;

/**
 * A usable homepage even when the sections table is empty (a fresh install, or a
 * database that has not been seeded yet). Falling back beats rendering a blank page:
 * the shell still shows games, and the operator can see what they are missing.
 */
function fallbackSections(): Section[] {
  return [
    {
      id: 'fallback-hero',
      page: 'home',
      kind: 'hero',
      title: 'العب فورًا — بلا تحميل ولا تسجيل',
      titleEn: 'Play instantly',
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

export default async function HomePage() {
  const sections = await getSections('home');
  const visible = sections.filter((section) => section.isVisible);

  if (!visible.length) {
    const { items } = await listGames({ perPage: 6, sort: 'popular' });
    if (!items.length) {
      return (
        <div className="mx-auto w-full max-w-3xl px-4 py-24 text-center">
          <p className="mb-2 text-5xl" aria-hidden>🎮</p>
          <h1 className="mb-3 text-2xl font-black text-ink">لا ألعاب منشورة بعد</h1>
          <p className="text-sm leading-8 text-muted">
            أضف ألعاب من لوحة التحكم (رفع ZIP أو استيراد من مزوّد)، أو شغّل بذر البيانات التجريبية، وستظهر الصفحة الرئيسية تلقائيًا.
          </p>
        </div>
      );
    }
  }

  return <Sections sections={visible.length ? visible : fallbackSections()} />;
}
