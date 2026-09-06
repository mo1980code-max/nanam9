/**
 * The root layout: language, direction, theme, chrome, and site-wide structured data.
 *
 * `lang="ar"` + `dir="rtl"` are set on <html> itself, not on a wrapper div. That is
 * what makes the browser apply Arabic line-breaking, bidi punctuation and form
 * controls correctly, and it is the single most common thing Western templates get
 * wrong about Arabic portals.
 *
 * `suppressHydrationWarning` on <html> is required by next-themes: it writes the
 * resolved theme class before React hydrates, so the server markup and the first
 * client markup legitimately differ by that one attribute.
 */

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { SwRegister } from '@/components/sw-register';
import { ThemeProvider } from '@/components/theme-provider';
import { SiteHeader } from '@/components/header';
import { SiteFooter } from '@/components/footer';
import { getCategories, getLivePages, getSettings, settingValue, siteUrl } from '@/lib/api';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettings();
  const name = settingValue(settings, 'site.name', 'Voltade');
  const tagline = settingValue(settings, 'site.tagline', 'بوابة ألعاب HTML5 — العب فورًا بدون تحميل');
  const title = settingValue(settings, 'seo.defaultTitle', `${name} — ${tagline}`);
  const description = settingValue(settings, 'seo.defaultDescription', tagline);
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
  alternates: { canonical: '/' },
    openGraph: {
      type: 'website',
      siteName: name,
      title,
      description,
      url: siteUrl('/'),
      locale: 'ar_AR',
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

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [settings, categories, pages] = await Promise.all([getSettings(), getCategories(), getLivePages()]);
  const name = settingValue(settings, 'site.name', 'Voltade');
  const tagline = settingValue(settings, 'site.tagline', 'بوابة ألعاب HTML5 — العب فورًا بدون تحميل');

  const siteJsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${siteUrl('/')}#website`,
        url: siteUrl('/'),
        name,
        description: tagline,
        inLanguage: 'ar',
        publisher: { '@id': `${siteUrl('/')}#org` },
        // Sitelinks search box: this is the JSON-LD that makes Google render our own
        // search field under the listing.
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${siteUrl('/search')}?q={search_term_string}` },
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
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <SwRegister />
      <body className="antialiased">
        <ThemeProvider>
          <script
            type="application/ld+json"
            // This is JSON we produced from our own settings, never user HTML.
            dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd) }}
          />
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:start-3 focus:z-50 btn btn-primary"
          >
            تخطَّ إلى المحتوى
          </a>
          <SiteHeader
            siteName={name}
            tagline={tagline}
            logoUrl={settingValue(settings, 'site.logoUrl', '/brand/logo.svg')}
            categories={categories}
            registrationEnabled={settingValue<boolean>(settings, 'users.registrationEnabled', true)}
          />
          <main id="main" className="min-h-[70vh]">
            {children}
          </main>
          <SiteFooter siteName={name} tagline={tagline} categories={categories} pages={pages} />
        </ThemeProvider>
      </body>
    </html>
  );
}
