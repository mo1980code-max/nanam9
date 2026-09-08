'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { t, type Locale } from '@/lib/i18n';

/**
 * Dark/light switch.
 *
 * The icon is only rendered after mount: `useTheme()` cannot know the resolved
 * theme during SSR (it depends on a cookie and a media query that only exist in
 * the browser), so painting an icon immediately would hydrate to the wrong one
 * and React would warn about the mismatch.
 */
export function ThemeToggle({ locale = 'ar' }: { locale?: Locale }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="btn btn-ghost !px-3"
      aria-label={isDark ? t(locale, 'theme.toLight') : t(locale, 'theme.toDark')}
      title={isDark ? t(locale, 'theme.light') : t(locale, 'theme.dark')}
    >
      <span aria-hidden className="text-lg leading-none">
        {mounted ? (isDark ? '☀️' : '🌙') : '🌗'}
      </span>
    </button>
  );
}
