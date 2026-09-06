'use client';

/**
 * /login — a client component on purpose: the credentials never touch the server-render
 * path, the request goes browser → /api (same origin, rewrite) → API, and the session and
 * CSRF cookies land on this origin where every later client call can use them.
 *
 * The 2FA step is handled inline: when the API answers `2fa_required` the form swaps to a
 * code field instead of failing. That is the whole point of having designed the endpoint
 * to say *why* it refused.
 */

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch, errorMessage } from '@/lib/client-api';

export default function LoginPage() {
  // useSearchParams() needs a Suspense boundary during static prerender.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') || '/';

  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needs2fa, setNeeds2fa] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { status, payload } = await apiFetch('/auth/login', {
      method: 'POST',
      body: { login: login.trim(), password, remember, code: needs2fa && code.trim() ? code.trim() : undefined },
    });
    setBusy(false);

    if (status === 200 || status === 201) {
      router.replace(next.startsWith('/') ? next : '/');
      router.refresh();
      return;
    }
    if (status === 401 && (payload as { error?: { code?: string } })?.error?.code === 'auth.2fa_required') {
      setNeeds2fa(true);
      setError('هذا الحساب محمي بالتحقق بخطوتين: أدخل الرمز من تطبيق المصادقة.');
      return;
    }
    setError(errorMessage(status, payload));
  };

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <div className="card p-6 sm:p-8">
        <p className="mb-1 text-center text-4xl" aria-hidden>🎮</p>
        <h1 className="mb-2 text-center text-2xl font-black text-ink">تسجيل الدخول</h1>
        <p className="mb-6 text-center text-sm text-muted">لحفظ المفضلة والتعليق والمنافسة على النقاط.</p>

        <form onSubmit={submit} className="grid gap-4" noValidate>
          <Field label="اسم المستخدم أو البريد">
            <input
              className="input"
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              autoComplete="username"
              required
              minLength={3}
              placeholder="player_one"
            />
          </Field>
          <Field label="كلمة المرور">
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              minLength={1}
              placeholder="••••••••"
            />
          </Field>

          {needs2fa ? (
            <Field label="رمز التحقق (6 أرقام)">
              <input
                className="input text-center tracking-[0.5em]"
                dir="ltr"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                placeholder="000000"
              />
            </Field>
          ) : null}

          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            أبقني مسجّلًا على هذا الجهاز لمدة 30 يومًا
          </label>

          {error ? (
            <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm font-bold text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn btn-primary justify-center" disabled={busy}>
            {busy ? 'جارٍ الدخول…' : 'دخول'}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-muted">
          لا حساب لديك؟{' '}
          <Link href="/register" className="font-bold text-brand hover:underline">سجّل مجانًا</Link>
        </p>
      </div>

      <p className="mt-4 text-center text-xs leading-6 text-muted">
        المتابعة تعني موافقتك على الشروط وسياسة الخصوصية. اللعب ممكن بدون حساب أيضًا.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-bold text-ink">{label}</span>
      {children}
    </label>
  );
}
