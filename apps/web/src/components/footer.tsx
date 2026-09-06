/**
 * Site footer — server component.
 *
 * It is built from the same data the navigation uses (categories, published CMS pages)
 * rather than a hardcoded list of links, so a page created in the admin panel appears
 * in the footer without a deploy. Internal links in a footer are also how a crawler
 * discovers the pages that nothing else points at.
 */

import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';
import type { Category } from '@/lib/api';

type Props = {
  siteName: string;
  tagline: string;
  categories: Category[];
  pages: { slug: string; title: string; url: string }[];
};

export function SiteFooter({ siteName, tagline, categories, pages }: Props) {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-16 border-t border-line bg-surface/60">
      <div className="mx-auto grid w-full max-w-7xl gap-8 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="mb-3 flex items-center gap-2.5">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand to-accent text-lg text-white">
              <span aria-hidden>⚡</span>
            </span>
            <span className="text-lg font-black text-ink">{siteName}</span>
          </div>
          <p className="mb-4 max-w-xs text-sm leading-7 text-muted">{tagline}</p>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link href="/blog" className="btn btn-ghost !px-3" aria-label="المدونة">📝</Link>
          </div>
        </div>

        <nav aria-label="التصنيفات">
          <h2 className="mb-3 text-sm font-black text-ink">التصنيفات</h2>
          <ul className="grid gap-2">
            {categories.slice(0, 8).map((category) => (
              <li key={category.id}>
                <Link href={category.url || `/category/${category.slug}`} className="text-sm text-muted transition-colors hover:text-brand">
                  {category.icon ? `${category.icon} ` : ''}
                  {category.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-label="روابط الموقع">
          <h2 className="mb-3 text-sm font-black text-ink">الموقع</h2>
          <ul className="grid gap-2">
            <li><Link href="/games" className="text-sm text-muted transition-colors hover:text-brand">كل الألعاب</Link></li>
            <li><Link href="/search" className="text-sm text-muted transition-colors hover:text-brand">البحث</Link></li>
            <li><Link href="/blog" className="text-sm text-muted transition-colors hover:text-brand">المدونة</Link></li>
            {pages.map((page) => (
              <li key={page.slug}>
                <Link href={page.url} className="text-sm text-muted transition-colors hover:text-brand">{page.title}</Link>
              </li>
            ))}
          </ul>
        </nav>

        <div>
          <h2 className="mb-3 text-sm font-black text-ink">لماذا {siteName}؟</h2>
          <ul className="grid gap-2 text-sm text-muted">
            <li>🚀 يعمل فورًا — بلا تحميل ولا تثبيت</li>
            <li>📱 متجاوب بالكامل ويعمل كتطبيق</li>
            <li>🔒 بلا تتبّع خفي وبلا إعلانات بينية مزعجة</li>
            <li>🧭 تصنيفات متعددة المستويات ووسوم دقيقة</li>
          </ul>
        </div>
      </div>

      <div className="border-t border-line px-4 py-5">
        <p className="mx-auto max-w-7xl text-center text-xs text-muted">
          © {year} {siteName}. جميع الألعاب مملوكة لمطوّريها، وتُعرض وفق شروط التوزيع الخاصة بها.
        </p>
      </div>
    </footer>
  );
}
