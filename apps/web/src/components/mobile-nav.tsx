'use client';

/**
 * The mobile drawer.
 *
 * A client component because a drawer is state. It renders into place (no portal) and
 * closes on Escape or on navigation, and body scroll is locked while it is open —
 * a menu that scrolls the page behind it is the single most common mobile-UI bug.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Category } from '@/lib/api';
import { l, n, pick, t, type Locale, type MessageKey } from '@/lib/i18n';

type Props = { locale: Locale; categories: Category[]; registrationEnabled: boolean };

const LINKS: { path: string; label: MessageKey; icon: string }[] = [
  { path: '/', label: 'nav.home', icon: '🏠' },
  { path: '/games', label: 'nav.allGames', icon: '🎮' },
  { path: '/blog', label: 'nav.blog', icon: '📝' },
  { path: '/search', label: 'nav.search', icon: '🔎' },
];

export function MobileNav({ locale, categories, registrationEnabled }: Props) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn btn-ghost !px-3 lg:hidden"
        aria-label={t(locale, 'nav.openMenu')}
        aria-expanded={open}
      >
        <span aria-hidden className="text-lg leading-none">☰</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={t(locale, 'nav.menu')}>
          <button type="button" aria-label={t(locale, 'nav.close')} className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <nav className="absolute inset-y-0 start-0 flex w-[86%] max-w-sm flex-col overflow-y-auto border-e border-line bg-bg p-4 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-lg font-black text-ink">{t(locale, 'nav.menu')}</span>
              <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost !px-3" aria-label={t(locale, 'nav.closeMenu')}>
                <span aria-hidden>✕</span>
              </button>
            </div>

            <ul className="mb-5 grid gap-1">
              {LINKS.map((link) => (
                <li key={link.path}>
                  <Link
                    href={l(locale, link.path)}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold transition-colors ${
                      pathname === l(locale, link.path) ? 'bg-brand-soft text-brand' : 'text-ink hover:bg-surface-2'
                    }`}
                  >
                    <span aria-hidden>{link.icon}</span>
                    {t(locale, link.label)}
                  </Link>
                </li>
              ))}
            </ul>

            <p className="mb-2 px-1 text-xs font-black text-muted">{t(locale, 'nav.categories')}</p>
            <ul className="grid gap-1">
              {categories.map((category) => (
                <li key={category.id}>
                  <Link
                    href={category.url ? l(locale, category.url) : l(locale, `/category/${category.slug}`)}
                    className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold text-ink transition-colors hover:bg-surface-2"
                  >
                    <span
                      aria-hidden
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-base"
                      style={{ backgroundColor: `${category.color ?? '#7c3aed'}22` }}
                    >
                      {category.icon ?? '🎮'}
                    </span>
                    <span className="flex-1 truncate">{pick(locale, category.name, category.nameEn)}</span>
                    <span className="text-xs text-muted">{n(locale, category.gamesCount)}</span>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="mt-auto grid gap-2 pt-6">
              <Link href={l(locale, '/login')} className="btn btn-primary">{t(locale, 'nav.login')}</Link>
              {registrationEnabled && (
                <Link href={l(locale, '/login')} className="btn btn-ghost">{t(locale, 'mobile.googleLogin')}</Link>
              )}
            </div>
          </nav>
        </div>
      )}
    </>
  );
}
