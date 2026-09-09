/**
 * /register no longer exists as a form: with Google as the only sign-in method the
 * account is created by the first sign-in itself. The route stays (per locale) so old
 * links never 404 — they simply arrive at the sign-in button.
 */

import { redirect } from 'next/navigation';
import { isLocale, l } from '@/lib/i18n';

export default async function RegisterPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect(l(isLocale(locale) ? locale : 'ar', '/login'));
}
