'use client';

/**
 * The admin shell: one client-side guard, one sidebar, every admin page inside.
 *
 * WHY A CLIENT GUARD: the session lives in httpOnly cookies, so a Server Component
 * cannot present them to the API — only the browser can. The guard therefore asks
 * /api/auth/me with the browser's cookies and redirects before painting anything
 * sensitive. Every data call underneath is still authorised by the API itself
 * (RolesGuard + @Permissions), so this guard is UX, not security.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/client-api';

type Me = {
  username: string;
  displayName: string | null;
  role: { slug: string; name: string } | null;
};

const NAV: { href: string; label: string; icon: string; exact: boolean }[] = [
  { href: '/admin', label: 'لوحة الإدارة', icon: '📊', exact: true },
  { href: '/admin/games', label: 'إدارة الألعاب', icon: '🎮', exact: false },
  { href: '/admin/taxonomy', label: 'التصنيفات والوسوم', icon: '🗂️', exact: false },
  { href: '/admin/blog', label: 'إدارة المدونة', icon: '📝', exact: false },
  { href: '/admin/users', label: 'المستخدمون', icon: '👥', exact: false },
  { href: '/admin/reports', label: 'البلاغات', icon: '🚩', exact: false },
  { href: '/admin/ads', label: 'إدارة الإعلانات', icon: '📢', exact: false },
  { href: '/admin/sections', label: 'بانئ الأقسام', icon: '🧩', exact: false },
  { href: '/admin/activity', label: 'سجل النشاط', icon: '📜', exact: false },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'anon' | 'denied' | 'ok'>('loading');

  useEffect(() => {
    if (pathname === '/admin/login') return;
    let cancelled = false;
    (async () => {
      const { status, payload } = await apiFetch<{ data?: Me }>('/auth/me');
      if (cancelled) return;
      if (status !== 200) {
        setState('anon');
        router.replace(`/admin/login?next=${encodeURIComponent(pathname)}`);
        return;
      }
      const user = (payload as { data?: Me }).data ?? null;
      const role = user?.role?.slug;
      if (!user || (role !== 'super-admin' && role !== 'admin')) {
        setMe(user);
        setState('denied');
        return;
      }
      setMe(user);
      setState('ok');
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  const logout = useCallback(async () => {
    await apiFetch('/auth/logout', { method: 'POST', body: {} });
    router.replace('/admin/login');
    router.refresh();
  }, [router]);

  if (pathname === '/admin/login') return <>{children}</>;

  if (state === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-surface-2">
        <div className="grid gap-3 justify-items-center">
          <div className="skeleton h-10 w-10 rounded-2xl" />
          <div className="skeleton h-4 w-40 rounded-full" />
        </div>
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <div className="grid min-h-screen place-items-center bg-surface-2 px-4">
        <div className="card max-w-md p-8 text-center">
          <p className="mb-3 text-4xl" aria-hidden>🔒</p>
          <h1 className="mb-2 text-xl font-black text-ink">ليست لديك صلاحية اللوحة</h1>
          <p className="mb-6 text-sm leading-7 text-muted">حسابك الحالي لا يحمل دور مشرف. إن كنت تعتقد أن هذا خطأ، فاطلب رفع دورك من مدير المنصة.</p>
          <div className="flex justify-center gap-2">
            <Link href="/" className="btn btn-primary">العودة للموقع</Link>
            <button type="button" onClick={logout} className="btn btn-ghost">تبديل الحساب</button>
          </div>
        </div>
      </div>
    );
  }

  const current = NAV.find((item) => (item.exact ? pathname === item.href : pathname.startsWith(item.href)));

  return (
    <div className="min-h-screen bg-surface-2 lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      {/* ---------------------------------------------------------- sidebar */}
      <aside className="border-b border-[var(--border)] bg-surface lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-e">
        <div className="flex items-center justify-between gap-3 px-4 py-4 lg:flex-col lg:items-stretch lg:justify-start lg:gap-6 lg:py-6">
          <Link href="/admin" className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand to-accent text-lg text-white" aria-hidden>⚡</span>
            <span className="leading-tight">
              <span className="block text-sm font-black text-ink">Voltade</span>
              <span className="block text-[10px] font-bold text-muted">لوحة التحكم</span>
            </span>
          </Link>

          <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible" aria-label="أقسام اللوحة">
            {NAV.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-bold transition-colors ${
                    active ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-2 hover:text-ink'
                  }`}
                >
                  <span aria-hidden>{item.icon}</span>
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="hidden lg:mt-auto lg:grid lg:gap-2">
            <Link href="/" className="btn btn-ghost justify-center text-xs">
              👀 عرض الموقع
            </Link>
            <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-black text-brand" aria-hidden>
                {(me?.displayName ?? me?.username ?? '؟').charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-xs font-black text-ink">{me?.displayName ?? me?.username}</span>
                <span className="block truncate text-[10px] text-muted">{me?.role?.name}</span>
              </span>
              <button type="button" onClick={logout} title="خروج" className="text-muted transition-colors hover:text-red-500" aria-label="تسجيل الخروج">
                ⎋
              </button>
            </div>
          </div>

          <button type="button" onClick={logout} className="btn btn-ghost !px-3 text-xs lg:hidden">
            خروج
          </button>
        </div>
      </aside>

      {/* ---------------------------------------------------------- content */}
      <main className="min-w-0 px-4 py-5 sm:px-6 sm:py-7">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-black text-ink sm:text-2xl">{current?.label ?? 'لوحة الإدارة'}</h1>
          <span className="flex items-center gap-1.5 text-[11px] font-bold text-muted">
            <span className="relative flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            متصل ومباشر
          </span>
        </header>
        {children}
      </main>
    </div>
  );
}
