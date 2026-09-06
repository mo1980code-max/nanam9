'use client';

/**
 * next-themes in a client component: the App Router's root layout is a Server
 * Component, and a theme provider has to own state and an effect.
 *
 * `attribute="class"` matches the `.dark` variant in globals.css, and
 * `enableSystem` is what makes the portal follow the OS preference on a first
 * visit — the requirement was "detect the system automatically", and this is the
 * three lines that do it without a flash of the wrong theme.
 */

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ReactNode } from 'react';

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
