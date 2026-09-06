/**
 * /manifest.webmanifest — the install manifest (PWA).
 *
 * Served from a route, not a static file, because the name and colours come from the
 * site settings an operator edits in the admin panel: rebranding the portal should not
 * require a deploy. Icons are static because they are design assets.
 *
 * `maskable` + `any` purpose pairs keep Android from cropping or letterboxing the mark,
 * and `dir: rtl` is what makes the install prompt itself appear in the right direction.
 */

import type { MetadataRoute } from 'next';
import { getSettings, settingValue } from '@/lib/api';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const settings = await getSettings();
  const name = settingValue(settings, 'site.name', 'Voltade');
  const tagline = settingValue(settings, 'site.tagline', 'بوابة ألعاب HTML5');

  return {
    id: '/',
    name: `${name} — ${tagline}`,
    short_name: name,
    description: settingValue(settings, 'seo.metaDescription', 'العب آلاف ألعاب HTML5 مجانًا في المتصفح، بلا تحميل ولا تسجيل.'),
    lang: 'ar',
    dir: 'rtl',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#0b0b12',
    theme_color: settingValue(settings, 'theme.color', '#7c3aed'),
    categories: ['games', 'entertainment'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'كل الألعاب', url: '/games', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'المتصدرون', url: '/leaderboard', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
