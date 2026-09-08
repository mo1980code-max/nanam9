/**
 * The portal root layout: language, direction, theme, chrome, and site-wide structured data.
 *
 * This is a ROOT layout in the route-group sense: `(portal)/[locale]` renders its own
 * <html>, and `(admin)/admin` renders its own — two independent document trees in one
 * app. That is what lets `lang` and `dir` come from the URL segment instead of being
 * pinned in a shared wrapper: /ar/… is rtl Arabic, /en/… is ltr English, and the browser
 * applies the right line-breaking, bidi punctuation and form behaviour to each.
 *
 * `suppressHydrationWarning` on <html> is required by next-themes: it writes the
 * resolved theme class before React hydrates, so the server markup and the first
 * client markup legitimately differ by that one attribute.
 */

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { SwRegister } from '@/components/sw-register';
import { ThemeProvider } from '@/components/theme-provider';
import { SiteHeader } from '@/components/header';
import { SiteFooter } from '@/components/footer';
import { getCategories, getLivePages, getSettings, settingValue, siteUrl } from '@/lib/api';
import { DEFAULT_LOCALE, LOCALES, dirFor, isLocale, localeAlternates, t, type Locale } from '@/lib/i18n';
import '../../globals.css';

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

const TAGLINES: Record<Locale, string> = {
  ar: 'بوابة ألعاب HTML5 — العب فورًا بدون تحميل',
  en: 'The HTML5 games portal — play instantly, no downloads',
};

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale: raw } = await params;
  const locale: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const settings = await getSettings();
  const name = settingValue(settings, 'site.name', 'Voltade');
  const tagline = locale === 'ar' ? settingValue(settings, 'site.tagline', TAGLINES.ar) : TAGLINES.en;
  const title = locale === 'ar' ? settingValue(settings, 'seo.defaultTitle', `${name} — ${tagline}`) : `${name} — ${tagline}`;
  const description = locale === 'ar' ? settingValue(settings, 'seo.defaultDescription', tagline) : tagline;
  const ogImage = settingValue(settings, 'site.ogImageUrl', '/brand/og-default.svg');

  return {
    metadataBase: new URL(siteUrl('/')),
    title: {
      default: title,
      // Every page's title goes through this template, so the brand is never missing
      // and never has to be repeated in 40 separate generateMetadata functions.
      template: `%s | ${name}`,
    },
    description,
    keywords: settingValue<string | undefined>(settings, 'seo.keywords', undefined),
    applicationName: name,
    icons: {
      icon: [
        { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
        { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
      apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    },
    // The hreflang cluster: Arabic, English, and x-default pointing at the primary.
    alternates: localeAlternates(locale, '/'),
    openGraph: {
      type: 'website',
      siteName: name,
      title,
      description,
      url: siteUrl(`/${locale}`),
      locale: locale === 'ar' ? 'ar_AR' : 'en_US',
      images: [{ url: ogImage, width: 1200, height: 630, alt: name }],
    },
    twitter: { card: 'summary_large_image', title, description, images: [ogImage] },
    robots: { index: true, follow: true, googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 } },
    formatDetection: { telephone: false, address: false, email: false },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f5fb' },
    { media: '(prefers-color-scheme: dark)', color: '#07070f' },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  colorScheme: 'dark light',
};

export default async function PortalLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

  const [settings, categories, pages] = await Promise.all([getSettings(), getCategories(), getLivePages()]);
  const name = settingValue(settings, 'site.name', 'Voltade');
  const tagline = locale === 'ar' ? settingValue(settings, 'site.tagline', TAGLINES.ar) : TAGLINES.en;

  const siteJsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${siteUrl(`/${locale}`)}#website`,
        url: siteUrl(`/${locale}`),
        name,
        description: tagline,
        inLanguage: locale,
        publisher: { '@id': `${siteUrl('/')}#org` },
        // Sitelinks search box: this is the JSON-LD that makes Google render our own
        // search field under the listing.
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${siteUrl(`/${locale}/search`)}?q={search_term_string}` },
          'query-input': 'required name=search_term_string',
        },
      },
      {
        '@type': 'Organization',
        '@id': `${siteUrl('/')}#org`,
        name,
        url: siteUrl('/'),
        logo: siteUrl('/brand/logo.svg'),
        slogan: tagline,
      },
    ],
  };

  return (
    <html lang={locale} dir={dirFor(locale)} suppressHydrationWarning>
      <SwRegister />
      <body className="antialiased">
        <ThemeProvider>
          <script
            type="application/ld+json"
            // This is JSON we produced from our own settings, never user HTML.
            dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd) }}
          />
          <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:start-3 focus:z-50 btn btn-primary">
            {t(locale, 'nav.skip')}
          </a>
          <SiteHeader
            locale={locale}
            siteName={name}
            tagline={tagline}
            logoUrl={settingValue(settings, 'site.logoUrl', '/brand/logo.svg')}
            categories={categories}
            registrationEnabled={settingValue<boolean>(settings, 'users.registrationEnabled', true)}
          />
          <main id="main" className="min-h-[70vh]">
            {children}
          </main>
          <SiteFooter locale={locale} siteName={name} tagline={tagline} categories={categories} pages={pages} />
        </ThemeProvider>
      </body>
    </html>
  );
}
