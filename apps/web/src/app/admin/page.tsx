'use client';

/**
 * /admin — the live dashboard.
 *
 * One API call (/admin/stats) returns everything, pre-aggregated from the daily
 * rollup, so keeping this page open with a 30-second refresh is cheap for the
 * database — which is the whole point of an ops screen: people leave it open.
 *
 * Charts are hand-rolled SVG/flex bars on purpose: a chart library would add
 * ~80 KiB of JavaScript to a page only two people ever visit, and RTL bar charts
 * need direction handling most libraries fight against.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/client-api';
import { mediaUrl } from '@/lib/api';

type Stats = {
  totals: {
    games: number;
    publishedGames: number;
    users: number;
    plays: number;
    comments: number;
    pendingComments: number;
    openReports: number;
  };
  timeline: { day: string; views: number; plays: number; uniqueVisitors: number }[];
  topGames: { id: string; slug: string; title: string; thumbnailUrl: string; plays: number; ratingAvg: number }[];
  sources: { source: string; plays: number }[];
  devices: { device: string; plays: number }[];
  countries: { country: string; plays: number }[];
  categories: { slug: string; name: string; gamesCount: number }[];
};

const nf = new Intl.NumberFormat('ar-EG');
const REFRESH_MS = 30_000;

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const { status, payload } = await apiFetch<Stats>('/admin/stats?days=14');
    if (status === 200) {
      setStats((payload as { data: Stats }).data);
      setUpdatedAt(new Date());
      setError(null);
    } else {
      setError('تعذّر تحميل الإحصاءات — تحقق من الاتصال بالـAPI.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (error && !stats) {
    return <div className="card p-8 text-center text-sm font-bold text-red-500">{error}</div>;
  }
  if (!stats) {
    return (
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-24 rounded-2xl" />
          ))}
        </div>
        <div className="skeleton h-64 rounded-2xl" />
      </div>
    );
  }

  const today = stats.timeline.at(-1);
  const cards = [
    { label: 'إجمالي اللعبات', value: stats.totals.plays, icon: '▶️', hint: `اليوم: ${nf.format(today?.plays ?? 0)}` },
    { label: 'الألعاب المنشورة', value: stats.totals.publishedGames, icon: '🎮', hint: `من أصل ${nf.format(stats.totals.games)}` },
    { label: 'المستخدمون', value: stats.totals.users, icon: '👥', hint: 'حساب مسجّل' },
    { label: 'التعليقات', value: stats.totals.comments, icon: '💬', hint: `معلّقة: ${nf.format(stats.totals.pendingComments)}` },
    { label: 'بلاغات مفتوحة', value: stats.totals.openReports, icon: '🚨', hint: 'بانتظار moderation' },
    { label: 'زوار فريدون (14 يوم)', value: stats.timeline.reduce((sum, day) => sum + day.uniqueVisitors, 0), icon: '🧭', hint: 'من rollup اليومي' },
  ];

  return (
    <div className="grid gap-5">
      {/* ------------------------------------------------------------ KPI cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {cards.map((card) => (
          <div key={card.label} className="card p-4">
            <p className="mb-1 flex items-center justify-between text-[11px] font-bold text-muted">
              {card.label}
              <span aria-hidden>{card.icon}</span>
            </p>
            <p className="text-2xl font-black text-ink">{nf.format(card.value)}</p>
            <p className="mt-1 text-[10px] text-muted">{card.hint}</p>
          </div>
        ))}
      </div>

      {/* ------------------------------------------------------------ timeline */}
      <section className="card p-5" aria-labelledby="timeline-heading">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 id="timeline-heading" className="text-base font-black text-ink">آخر 14 يومًا — اللعبات والزوار</h2>
          <p className="text-[11px] text-muted">
            آخر تحديث {updatedAt ? updatedAt.toLocaleTimeString('ar-EG') : '—'} · تحدَّث كل 30 ثانية
          </p>
        </div>
        <TimelineChart timeline={stats.timeline} />
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {/* ---------------------------------------------------------- top games */}
        <section className="card p-5" aria-labelledby="top-heading">
          <h2 id="top-heading" className="mb-4 text-base font-black text-ink">الألعاب الأعلى لعبًا</h2>
          <ul className="grid gap-2.5">
            {stats.topGames.map((game, index) => {
              const max = stats.topGames[0]?.plays || 1;
              return (
                <li key={game.id} className="flex items-center gap-3">
                  <span className="w-6 shrink-0 text-center text-xs font-black text-muted">{nf.format(index + 1)}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {game.thumbnailUrl ? <img src={mediaUrl(game.thumbnailUrl) ?? ''} alt="" className="h-9 w-12 shrink-0 rounded-lg object-cover" /> : null}
                  <span className="min-w-0 flex-1">
                    <Link href={`/game/${game.slug}`} className="block truncate text-sm font-bold text-ink hover:text-brand">
                      {game.title}
                    </Link>
                    <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                      <span className="block h-full rounded-full bg-gradient-to-l from-brand to-accent" style={{ width: `${Math.round((game.plays / max) * 100)}%` }} />
                    </span>
                  </span>
                  <span className="shrink-0 text-xs font-black text-brand">{nf.format(game.plays)}</span>
                  <span className="w-10 shrink-0 text-end text-[11px] text-muted">★ {game.ratingAvg?.toFixed(1) ?? '—'}</span>
                </li>
              );
            })}
          </ul>
        </section>

        {/* --------------------------------------------------- breakdowns */}
        <div className="grid gap-5">
          <section className="card p-5" aria-labelledby="devices-heading">
            <h2 id="devices-heading" className="mb-3 text-base font-black text-ink">الأجهزة</h2>
            <Bars rows={stats.devices.map((row) => ({ label: DEVICE_LABELS[row.device] ?? row.device, value: row.plays }))} />
          </section>
          <section className="card p-5" aria-labelledby="sources-heading">
            <h2 id="sources-heading" className="mb-3 text-base font-black text-ink">مصادر الزيارات</h2>
            {stats.sources.length ? (
              <Bars rows={stats.sources.map((row) => ({ label: row.source || 'مباشر', value: row.plays }))} />
            ) : (
              <p className="text-xs text-muted">لا بيانات مصادر بعد — تُجمع من معاملات utm وreferrer.</p>
            )}
          </section>
          <section className="card p-5" aria-labelledby="cats-heading">
            <h2 id="cats-heading" className="mb-3 text-base font-black text-ink">أكبر التصنيفات</h2>
            <div className="flex flex-wrap gap-1.5">
              {stats.categories.map((category) => (
                <Link key={category.slug} href={`/category/${category.slug}`} className="chip text-[11px]">
                  {category.name}
                  <span className="opacity-70">{nf.format(category.gamesCount)}</span>
                </Link>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

const DEVICE_LABELS: Record<string, string> = { desktop: 'حاسوب', mobile: 'جوال', tablet: 'جهاز لوحي', bot: 'زاحف' };

function TimelineChart({ timeline }: { timeline: Stats['timeline'] }) {
  const max = Math.max(1, ...timeline.map((day) => day.plays));
  return (
    <div>
      <div className="flex h-44 items-end gap-1.5 sm:gap-2" role="img" aria-label="رسم بياني أعمدة للعبات آخر 14 يومًا">
        {timeline.map((day) => (
          <div key={day.day} className="group relative flex h-full flex-1 flex-col justify-end gap-1">
            <div
              className="rounded-t-lg bg-gradient-to-t from-brand to-accent opacity-80 transition-opacity group-hover:opacity-100"
              style={{ height: `${Math.max(3, Math.round((day.plays / max) * 100))}%` }}
              title={`${day.day}: ${nf.format(day.plays)} لعبة`}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5 sm:gap-2">
        {timeline.map((day, index) => (
          <span key={day.day} className="flex-1 text-center text-[9px] text-muted">
            {index % 2 === 0 ? day.day.slice(8, 10) : ''}
          </span>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-muted">
        <Legend color="bg-gradient-to-t from-brand to-accent" label="لعبات" />
        <Legend color="bg-surface-2" label={`ذروة: ${nf.format(max)}`} />
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded ${color}`} aria-hidden />
      {label}
    </span>
  );
}

function Bars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul className="grid gap-2">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[70px_minmax(0,1fr)_56px] items-center gap-2 text-xs">
          <span className="truncate font-bold text-ink">{row.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.round((row.value / max) * 100)}%` }} />
          </span>
          <span className="text-end font-black text-muted">{nf.format(row.value)}</span>
        </li>
      ))}
    </ul>
  );
}
