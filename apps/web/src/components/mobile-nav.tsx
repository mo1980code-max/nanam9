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

type Props = { categories: Category[]; registrationEnabled: boolean };

const LINKS = [
  { href: '/', label: 'الرئيسية', icon: '🏠' },
  { href: '/games', label: 'كل الألعاب', icon: '🎮' },
  { href: '/blog', label: 'المدونة', icon: '📝' },
  { href: '/search', label: 'البحث', icon: '🔎' },
];

export function MobileNav({ categories, registrationEnabled }: Props) {
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
        aria-label="فتح القائمة"
        aria-expanded={open}
      >
        <span aria-hidden className="text-lg leading-none">☰</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="القائمة">
          <button type="button" aria-label="إغلاق" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <nav className="absolute inset-y-0 start-0 flex w-[86%] max-w-sm flex-col overflow-y-auto border-e border-line bg-bg p-4 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-lg font-black text-ink">القائمة</span>
              <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost !px-3" aria-label="إغلاق القائمة">
                <span aria-hidden>✕</span>
              </button>
            </div>

            <ul className="mb-5 grid gap-1">
              {LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold transition-colors ${
                      pathname === link.href ? 'bg-brand-soft text-brand' : 'text-ink hover:bg-surface-2'
                    }`}
                  >
                    <span aria-hidden>{link.icon}</span>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>

            <p className="mb-2 px-1 text-xs font-black text-muted">التصنيفات</p>
            <ul className="grid gap-1">
              {categories.map((category) => (
                <li key={category.id}>
                  <Link
                    href={category.url || `/category/${category.slug}`}
                    className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold text-ink transition-colors hover:bg-surface-2"
                  >
                    <span
                      aria-hidden
                      className="grid h-8 w-8 place-items-center rounded-lg text-base"
                      style={{ backgroundColor: `${category.color ?? '#7c3aed'}22` }}
                    >
                      {category.icon ?? '🎮'}
                    </span>
                    <span className="flex-1 truncate">{category.name}</span>
                    <span className="text-xs text-muted">{category.gamesCount}</span>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="mt-auto grid gap-2 pt-6">
              <Link href="/login" className="btn btn-primary">دخول</Link>
              {registrationEnabled && (
                <Link href="/login" className="btn btn-ghost">الدخول بحساب جوجل</Link>
              )}
            </div>
          </nav>
        </div>
      )}
    </>
  );
}
