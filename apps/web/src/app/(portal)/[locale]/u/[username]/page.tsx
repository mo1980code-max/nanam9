/**
 * /[locale]/u/[username] — a public player profile.
 *
 * Leaderboard rows link here, so the route has to exist even before profiles are rich.
 * Shown: level and XP progress, public counters, achievements, public playlists.
 * Deliberately NOT shown: e-mail, play history, votes — those belong to the private
 * "my account" area, not to a page Google indexes.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getUserProfile, siteUrl } from '@/lib/api';
import { dateLocale, isLocale, l, localeAlternates, n, t, type Locale } from '@/lib/i18n';

export const revalidate = 60;

type Params = { locale: string; username: string };

type Achievement = { code?: string; name?: string; icon?: string; description?: string; earnedAt?: string | null };
type Playlist = { id?: string; title?: string; slug?: string; gamesCount?: number; isPublic?: boolean };

type ProfileView = {
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  website: string | null;
  role: { slug: string; name: string } | null;
  level: { level: number; xp: number; xpIntoLevel: number; xpForNextLevel: number; progress: number; nextLevelAt: number };
  counts: { plays: number; comments: number; favorites: number; playlists: number; badges: number };
  memberSince: string | null;
  achievements: Achievement[];
  playlists: Playlist[];
  url: string;
  shareUrl: string;
};

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { locale: raw, username } = await params;
  const locale: Locale = isLocale(raw) ? raw : 'ar';
  const profile = (await getUserProfile(username)) as ProfileView | null;
  const name = profile?.displayName || username;
  return {
    title: t(locale, 'profile.title', { name }),
    description: t(locale, 'profile.description', {
      name,
      level: profile ? n(locale, profile.level.level) : '—',
      plays: profile ? n(locale, profile.counts.plays) : n(locale, 0),
    }),
    alternates: localeAlternates(locale, `/u/${username}`),
    openGraph: { type: 'profile', title: name, url: siteUrl(l(locale, `/u/${username}`)) },
  };
}

export default async function ProfilePage({ params }: { params: Promise<Params> }) {
  const { locale: raw, username } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

  const profile = (await getUserProfile(username)) as ProfileView | null;
  if (!profile) notFound();

  const name = profile.displayName || username;
  const level = profile.level;
  const publicPlaylists = (profile.playlists ?? []).filter((playlist) => playlist.isPublic !== false);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <nav aria-label={t(locale, 'crumbs.aria')} className="mb-3 text-xs text-muted">
        <Link href={l(locale, '/')} className="hover:text-brand">{t(locale, 'crumbs.home')}</Link>
        <span aria-hidden className="mx-1.5">/</span>
        <Link href={l(locale, '/leaderboard')} className="hover:text-brand">{t(locale, 'nav.leaderboard')}</Link>
        <span aria-hidden className="mx-1.5">/</span>
        <span className="font-bold text-ink">{name}</span>
      </nav>

      <header className="card mb-5 overflow-hidden p-0">
        <div className="h-20 bg-gradient-to-l from-brand via-brand to-accent" aria-hidden />
        <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-end">
          <div className="-mt-16 grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-2xl border-4 border-surface bg-brand-soft text-4xl font-black text-brand shadow-lg">
            {profile.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={profile.avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span aria-hidden>{name.charAt(0).toUpperCase()}</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-black text-ink">{name}</h1>
              {profile.role ? <span className="chip chip-active text-[10px]">{profile.role.name}</span> : null}
            </div>
            <p dir="ltr" className="text-start text-sm text-muted">@{username}</p>
            {profile.bio ? <p className="mt-2 max-w-xl text-sm leading-7 text-muted">{profile.bio}</p> : null}
            <p className="mt-2 text-xs text-muted">
              {t(locale, 'profile.memberSince')}{' '}
              {profile.memberSince ? new Date(profile.memberSince).toLocaleDateString(dateLocale(locale), { year: 'numeric', month: 'long' }) : '—'}
            </p>
          </div>
        </div>

        {/* XP bar: the one visual that makes progression legible at a glance. */}
        <div className="border-t border-[var(--border)] px-6 py-4">
          <div className="mb-1.5 flex items-center justify-between text-xs font-bold">
            <span className="text-brand">{t(locale, 'leaderboard.level')} {n(locale, level.level)}</span>
            <span className="text-muted">
              {t(locale, 'profile.pointsNext', { into: n(locale, level.xpIntoLevel), for: n(locale, level.xpForNextLevel) })}
            </span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={level.progress} aria-valuemin={0} aria-valuemax={100} aria-label={t(locale, 'profile.progressAria')}>
            <div className="h-full rounded-full bg-gradient-to-l from-brand to-accent transition-all" style={{ width: `${Math.min(100, Math.max(0, level.progress))}%` }} />
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-px border-t border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
          <Stat label={t(locale, 'profile.totalPoints')} value={n(locale, level.xp)} />
          <Stat label={t(locale, 'profile.plays')} value={n(locale, profile.counts.plays)} />
          <Stat label={t(locale, 'profile.comments')} value={n(locale, profile.counts.comments)} />
          <Stat label={t(locale, 'profile.favorites')} value={n(locale, profile.counts.favorites)} />
        </dl>
      </header>

      <div className="grid gap-5 sm:grid-cols-2">
        <section className="card p-5" aria-labelledby="badges-heading">
          <h2 id="badges-heading" className="mb-3 text-base font-black text-ink">
            {t(locale, 'profile.badges')} <span className="text-xs font-bold text-muted">({n(locale, profile.counts.badges)})</span>
          </h2>
          {profile.achievements?.length ? (
            <ul className="grid gap-2">
              {profile.achievements.map((badge, index) => (
                <li key={badge.code ?? index} className="flex items-center gap-3 rounded-xl bg-surface-2 p-3">
                  <span aria-hidden className="text-2xl">{badge.icon ?? '🏅'}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-ink">{badge.name ?? badge.code ?? t(locale, 'profile.badgeFallback')}</span>
                    {badge.description ? <span className="block truncate text-xs text-muted">{badge.description}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm leading-7 text-muted">{t(locale, 'profile.noBadges')}</p>
          )}
        </section>

        <section className="card p-5" aria-labelledby="playlists-heading">
          <h2 id="playlists-heading" className="mb-3 text-base font-black text-ink">
            {t(locale, 'profile.playlists')} <span className="text-xs font-bold text-muted">({n(locale, publicPlaylists.length)})</span>
          </h2>
          {publicPlaylists.length ? (
            <ul className="grid gap-2">
              {publicPlaylists.map((playlist, index) => (
                <li key={playlist.id ?? index} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 p-3">
                  <span className="min-w-0 truncate text-sm font-bold text-ink">
                    <span aria-hidden className="ms-1">🎧</span>
                    {playlist.title ?? t(locale, 'profile.playlistFallback')}
                  </span>
                  <span className="shrink-0 text-xs text-muted">{n(locale, playlist.gamesCount ?? 0)} {t(locale, 'unit.games')}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm leading-7 text-muted">{t(locale, 'profile.noPlaylists')}</p>
          )}
          <div className="mt-4 border-t border-[var(--border)] pt-4">
            <Link href={l(locale, '/leaderboard')} className="btn btn-ghost w-full justify-center">{t(locale, 'leaderboard.title')}</Link>
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-4 py-3 text-center">
      <dt className="text-[10px] font-bold text-muted">{label}</dt>
      <dd className="text-lg font-black text-ink">{value}</dd>
    </div>
  );
}
