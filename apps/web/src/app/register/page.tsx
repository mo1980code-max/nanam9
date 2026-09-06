/**
 * /register no longer exists as a form: with Google as the only sign-in method the
 * account is created by the first sign-in itself. The route stays so old links and
 * the footer never 404 — they simply arrive at the sign-in button.
 */

import { redirect } from 'next/navigation';

export default function RegisterPage() {
  redirect('/login');
}
