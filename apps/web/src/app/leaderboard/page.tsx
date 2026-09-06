/**
 * /leaderboard — the XP table.
 *
 * Gamification only works if the scoreboard is public and cheap to look at: this page is
 * ISR-cached for two minutes, which is fresh enough for a contest and static enough to
 * survive a traffic spike the moment a new badge drops.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { getLeaderboard, siteUrl } from '@/lib/api';

export const revalidate = 120;

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'لوحة المتصدرين',
    description: 'أكثر اللاعبين نشاطًا: النقاط، المستويات، ومرات اللعب — محدّثة لحظيًا.',
    alternates: { canonical: '/leaderboard' },
    openGraph: { type: 'website', title: 'لوحة المتصدرين', url: siteUrl('/leaderboard') },
  };
}

const nf = new Intl.NumberFormat('ar-EG');
const MEDALS = ['🥇', '', '🥉'];

export default async function LeaderboardPage() {
  const rows = await getLeaderboard(50);
  const [first, second, third] = rows;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <nav aria-label="مسار التنقل" className="mb-3 text-xs text-muted">
        <Link href="/" className="hover:text-brand">الرئيسية</Link>
        <span aria-hidden className="mx-1.5">/</span>
        <span className="font-bold text-ink">المتصدرون</span>
      </nav>

      <header className="mb-6 text-center">
        <h1 className="mb-2 text-2xl font-black text-ink sm:text-4xl">لوحة المتصدرين</h1>
        <p className="text-sm leading-8 text-muted">
          تُحسب النقاط من اللعب والتعليقات والتقييمات والإنجازات. سجّل دخولك لتبدأ جمع النقاط وتنافس على المراكز الأولى.
        </p>
      </header>

      {first ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-3 sm:items-end">
          <Podium row={second} place={2} />
          <Podium row={first} place={1} />
          <Podium row={third} place={3} />
        </div>
      ) : (
        <div className="card mb-6 grid place-items-center px-6 py-16 text-center">
          <p className="mb-3 text-4xl" aria-hidden>🏆</p>
          <h2 className="mb-2 text-lg font-black text-ink">لا لاعبين بعد</h2>
          <p className="text-sm text-muted">كن أول من يسجّل ويبدأ الترتيب.</p>
        </div>
      )}

      {rows.length > 3 ? (
        <div className="card divide-y divide-[var(--border)] overflow-hidden">
          {rows.slice(3).map((row) => (
            <Link key={row.username} href={row.url || `/u/${row.username}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
              <span className="w-8 text-center text-sm font-black text-muted">{nf.format(row.rank)}</span>
              <Avatar name={row.displayName ?? row.username} url={row.avatarUrl} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-ink">{row.displayName ?? row.username}</span>
                <span className="block text-[11px] text-muted">المستوى {nf.format(row.level)} • {nf.format(row.plays)} مرة لعب</span>
              </span>
              <span className="shrink-0 rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-black text-brand">{nf.format(row.xp)} نقطة</span>
            </Link>
          ))}
        </div>
      ) : null}

      <p className="mt-6 text-center text-xs text-muted">
        ترتيبك يظهر داخل اللعبة وفي صفحة حسابك بعد تسجيل الدخول. •{' '}
        <Link href="/register" className="font-bold text-brand hover:underline">أنشئ حسابًا مجانًا</Link>
      </p>
    </div>
  );
}

function Podium({ row, place }: { row: { username: string; displayName: string | null; avatarUrl: string | null; level: number; xp: number } | undefined; place: 1 | 2 | 3 }) {
  if (!row) return <div className="hidden sm:block" aria-hidden />;
  const heights = { 1: 'sm:pb-10', 2: 'sm:pb-4', 3: 'sm:pb-0' } as const;
  return (
    <Link
      href={`/u/${row.username}`}
      className={`card flex flex-col items-center gap-2 p-5 text-center transition-all hover:-translate-y-0.5 hover:border-brand ${heights[place]} ${place === 1 ? 'order-first sm:order-none ring-2 ring-brand/40' : ''}`}
    >
      <span aria-hidden className="text-3xl">{MEDALS[place - 1]}</span>
      <Avatar name={row.displayName ?? row.username} url={row.avatarUrl} large />
      <span className="line-clamp-1 text-sm font-black text-ink">{row.displayName ?? row.username}</span>
      <span className="text-[11px] text-muted">المستوى {nf.format(row.level)}</span>
      <span className="rounded-full bg-brand-soft px-3 py-1 text-xs font-black text-brand">{nf.format(row.xp)} نقطة</span>
    </Link>
  );
}

function Avatar({ name, url, large = false }: { name: string; url: string | null; large?: boolean }) {
  const size = large ? 'h-16 w-16 text-2xl' : 'h-9 w-9 text-sm';
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className={`${size} shrink-0 rounded-full object-cover`} />
  ) : (
    <span aria-hidden className={`grid ${size} shrink-0 place-items-center rounded-full bg-brand-soft font-black text-brand`}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
