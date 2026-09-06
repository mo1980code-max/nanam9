/**
 * Site header — a Server Component.
 *
 * Everything interactive is a small client island inside it (the search dropdown, the
 * theme switch, the mobile drawer). The navigation itself, including the full category
 * mega-menu, ships as HTML: it is data from the API, it is crawlable without
 * JavaScript, and the dropdown opens with CSS `group-hover`/`focus-within` rather than
 * an event handler. A portal whose menu needs 40KB of JavaScript to appear is a portal
 * whose menu Googlebot may never see.
 */

import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';
import { SearchBox } from '@/components/search-box';
import { MobileNav } from '@/components/mobile-nav';
import type { Category } from '@/lib/api';

type Props = {
  siteName: string;
  tagline: string;
  logoUrl: string;
  categories: Category[];
  registrationEnabled: boolean;
};

export function SiteHeader({ siteName, tagline, logoUrl, categories, registrationEnabled }: Props) {
  const visible = categories.filter((category) => category.isVisible !== false).slice(0, 12);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-3 lg:gap-5">
        <MobileNav categories={visible} registrationEnabled={registrationEnabled} />

        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label={siteName}>
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand to-accent text-lg text-white shadow-lg">
            <span aria-hidden>⚡</span>
          </span>
          <span className="hidden leading-tight sm:block">
            <span className="block text-lg font-black tracking-tight text-ink">{siteName}</span>
            <span className="block max-w-[16rem] truncate text-[11px] text-muted">{tagline}</span>
          </span>
        </Link>

        <nav aria-label="التنقل الرئيسي" className="hidden items-center gap-1 lg:flex">
          <Link href="/" className="rounded-full px-3 py-2 text-sm font-bold text-muted transition-colors hover:bg-surface-2 hover:text-ink">
            الرئيسية
          </Link>
          <Link href="/games" className="rounded-full px-3 py-2 text-sm font-bold text-muted transition-colors hover:bg-surface-2 hover:text-ink">
            الألعاب
          </Link>

          {visible.length > 0 && (
            <div className="group relative">
              <button
                type="button"
                className="flex items-center gap-1 rounded-full px-3 py-2 text-sm font-bold text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                aria-haspopup="true"
              >
                التصنيفات
                <span aria-hidden className="text-[10px] transition-transform group-hover:rotate-180">▼</span>
              </button>
              <div className="invisible absolute start-0 top-full z-50 w-[34rem] pt-2 opacity-0 transition-all duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                <div className="grid grid-cols-2 gap-1.5 rounded-2xl border border-line bg-surface p-3 shadow-2xl">
                  {visible.map((category) => (
                    <Link
                      key={category.id}
                      href={category.url || `/category/${category.slug}`}
                      className="flex items-center gap-2.5 rounded-xl px-3 py-2 transition-colors hover:bg-surface-2"
                    >
                      <span
                        aria-hidden
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-base"
                        style={{ backgroundColor: `${category.color ?? '#7c3aed'}22`, color: category.color ?? '#7c3aed' }}
                      >
                        {category.icon ?? '🎮'}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-bold text-ink">{category.name}</span>
                        <span className="block truncate text-[11px] text-muted">
                          {category.gamesCount} لعبة
                          {category.children?.length ? ` · ${category.children.length} فرعي` : ''}
                        </span>
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          )}

          <Link href="/blog" className="rounded-full px-3 py-2 text-sm font-bold text-muted transition-colors hover:bg-surface-2 hover:text-ink">
            المدونة
          </Link>
        </nav>

        <div className="ms-auto hidden md:block md:w-64 xl:w-80">
          <SearchBox />
        </div>

        <div className="ms-auto flex items-center gap-2 md:ms-0">
          <Link href="/search" aria-label="بحث" className="btn btn-ghost !px-3 md:hidden">
            <span aria-hidden>🔎</span>
          </Link>
          <ThemeToggle />
          <Link href="/login" className="btn btn-primary !hidden !px-4 sm:!inline-flex">
            دخول
          </Link>
        </div>
      </div>

      {/* Mobile search: its own row, because a 40px input inside a 360px header row
          next to three buttons is not a usable target. */}
      <div className="border-t border-line px-4 py-2.5 md:hidden">
        <SearchBox />
      </div>
    </header>
  );
}
