/**
 * /[locale]/login — Google sign-in, and nothing else.
 *
 * One button, one provider, no password to forget. Accounts are created on first
 * sign-in. Server-rendered on purpose: the provider list comes from the API at render
 * time, and the page still works with JavaScript off. The `next` return path keeps the
 * visitor in the language they signed in from.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOAuthProviders, siteUrl } from '@/lib/api';
import { isLocale, l, localeAlternates, t, type Locale } from '@/lib/i18n';

export const revalidate = 60;

type Params = { locale: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { locale: raw } = await params;
  const locale: Locale = isLocale(raw) ? raw : 'ar';
  return {
    title: t(locale, 'login.title'),
    description: t(locale, 'login.description'),
    alternates: localeAlternates(locale, '/login'),
    robots: { index: false, follow: true },
    openGraph: { title: t(locale, 'login.title'), url: siteUrl(l(locale, '/login')) },
  };
}

const PROVIDER_LABELS: Record<string, string> = { google: 'Google' };

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

  const query = await searchParams;
  const returnTo = query.next?.startsWith('/') ? query.next : l(locale, '/');
  const providers = await getOAuthProviders();
  const enabled = providers.filter((provider) => provider.enabled);
  const errorCode = query.error;

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12">
      <div className="card p-7 sm:p-9">
        <p className="mb-2 text-center text-5xl" aria-hidden>🎮</p>
        <h1 className="mb-2 text-center text-2xl font-black text-ink">{t(locale, 'login.welcome')}</h1>
        <p className="mb-7 text-center text-sm leading-7 text-muted">
          {t(locale, 'login.body')}
          <br />
          {t(locale, 'login.body2')}
        </p>

        {errorCode ? (
          <p role="alert" className="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-center text-sm font-bold text-red-600 dark:text-red-400">
            {t(locale, 'login.failed', { code: errorCode })}
          </p>
        ) : null}

        {enabled.length ? (
          <div className="grid gap-3">
            {enabled.map((provider) => (
              <a
                key={provider.provider}
                href={`/api/auth/oauth/${provider.provider}?provider=${provider.provider}&redirect=${encodeURIComponent(returnTo)}`}
                className="btn h-12 justify-center gap-3 border border-line bg-surface text-sm font-black text-ink shadow-sm transition-transform hover:-translate-y-0.5 hover:border-brand"
              >
                {provider.provider === 'google' ? <GoogleMark /> : <span aria-hidden>🔑</span>}
                {t(locale, 'login.continueWith', { provider: PROVIDER_LABELS[provider.provider] ?? provider.provider })}
              </a>
            ))}
            {enabled.some((provider) => provider.dev) ? (
              <p className="rounded-xl bg-brand-soft px-4 py-2.5 text-center text-[11px] font-bold leading-6 text-brand">
                {t(locale, 'login.devNotice')}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="rounded-xl bg-surface-2 px-4 py-5 text-center text-sm leading-7 text-muted">
            {t(locale, 'login.disabled')}
            <br />
            {t(locale, 'login.disabled2')}
          </div>
        )}

        <p className="mt-6 text-center text-xs leading-6 text-muted">
          {t(locale, 'login.agree')}{' '}
          <Link href={l(locale, '/terms')} className="font-bold text-brand hover:underline">{t(locale, 'login.terms')}</Link> {t(locale, 'login.and')}{' '}
          <Link href={l(locale, '/privacy')} className="font-bold text-brand hover:underline">{t(locale, 'login.privacy')}</Link>.
        </p>
      </div>

      <p className="mt-5 text-center text-sm text-muted">
        <Link href={l(locale, '/games')} className="font-bold text-brand hover:underline">{t(locale, 'login.browseWithout')}</Link>
      </p>
    </div>
  );
}

/** The official four-colour G, inlined so the button needs no network round-trip. */
function GoogleMark() {
  return (
    <svg aria-hidden width="20" height="20" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.4-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}
