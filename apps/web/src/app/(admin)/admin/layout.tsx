/**
 * The admin route group's ROOT layout.
 *
 * With the portal moved under `(portal)/[locale]`, there is no app-level layout any
 * more — each route group renders its own <html>. The admin panel keeps Arabic/RTL on
 * purpose: it is the operators' tool, its whole vocabulary (sections builder, activity
 * log) is written for the Arabic-speaking team, and bilingual admin panels mostly buy
 * half-translated labels. Visitors never land here; the guard lives in AdminShell.
 */

import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import { ThemeProvider } from '@/components/theme-provider';
import { AdminShell } from './admin-shell';
import '../../globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'dark light',
};

export default function AdminRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider>
          <AdminShell>{children}</AdminShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
