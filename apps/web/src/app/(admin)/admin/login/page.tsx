'use client';

/**
 * /admin/login — the operator door, deliberately separate from the public /login.
 *
 * The public portal signs in with Google only; the admin panel keeps the password
 * form because an operator must be able to get in even when OAuth is misconfigured
 * (that is exactly the moment you need the dashboard). Same API endpoint, same
 * Argon2id verification, same session cookies — a different audience.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, errorMessage } from '@/lib/client-api';

export default function AdminLoginPage() {
  const router = useRouter();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { status, payload } = await apiFetch<{ user?: { role?: { slug?: string } } }>('/auth/login', {
      method: 'POST',
      body: { login: login.trim(), password, remember: true },
    });
    setBusy(false);
    if (status === 200 || status === 201) {
      const role = (payload as { data?: { user?: { role?: { slug?: string } } } })?.data?.user?.role?.slug;
      if (role !== 'super-admin' && role !== 'admin') {
        setError('هذا الحساب لا يملك صلاحية لوحة التحكم.');
        return;
      }
      router.replace('/admin');
      router.refresh();
      return;
    }
    setError(errorMessage(status, payload));
  };

  return (
    <div className="grid min-h-screen place-items-center bg-surface-2 px-4">
      <div className="card w-full max-w-md p-7 sm:p-9">
        <div className="mb-6 text-center">
          <p className="mb-2 text-4xl" aria-hidden>🛠️</p>
          <h1 className="mb-1 text-2xl font-black text-ink">لوحة تحكم Voltade</h1>
          <p className="text-sm text-muted">دخول المشرفين فقط — حسابات الدور Admin فأعلى.</p>
        </div>

        <form onSubmit={submit} className="grid gap-4" noValidate>
          <label className="grid gap-1.5">
            <span className="text-xs font-bold text-ink">اسم المستخدم أو البريد</span>
            <input className="input" value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="username" required />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-bold text-ink">كلمة المرور</span>
            <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </label>

          {error ? (
            <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm font-bold text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn btn-primary justify-center" disabled={busy}>
            {busy ? 'جارٍ التحقق…' : 'دخول اللوحة'}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-muted">
          الحساب التجريبي: <code dir="ltr">admin / Voltade!2026</code>
        </p>
      </div>
    </div>
  );
}
