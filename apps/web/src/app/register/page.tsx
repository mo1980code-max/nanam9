'use client';

/**
 * /register — account creation.
 *
 * Mirrors the API's RegisterDto exactly (username pattern, optional email, terms flag),
 * and re-states the rules under each field so the visitor learns them before the server
 * rejects them. Client-side validation is a courtesy, never a security boundary: the API
 * validates again with the same shared LIMITS constants.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, errorMessage } from '@/lib/client-api';

export default function RegisterPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // apiFetch returns the payload too; capture it for readable server messages.
  const submitWithPayload = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!accept) {
      setError('الموافقة على الشروط مطلوبة لإنشاء حساب.');
      return;
    }
    setBusy(true);
    setError(null);
    const { status, payload } = await apiFetch('/auth/register', {
      method: 'POST',
      body: {
        username: username.trim(),
        password,
        email: email.trim() || undefined,
        displayName: displayName.trim() || undefined,
        locale: 'ar',
        acceptTerms: true,
      },
    });
    setBusy(false);
    if (status === 200 || status === 201) {
      router.replace('/');
      router.refresh();
      return;
    }
    setError(errorMessage(status, payload));
  };

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <div className="card p-6 sm:p-8">
        <p className="mb-1 text-center text-4xl" aria-hidden>🚀</p>
        <h1 className="mb-2 text-center text-2xl font-black text-ink">حساب جديد</h1>
        <p className="mb-6 text-center text-sm text-muted">نقاط، أوسمة، مفضلة، وقوائم تشغيل شخصية — مجانًا وبلا بريد إن أمكن.</p>

        <form onSubmit={submitWithPayload} className="grid gap-4" noValidate>
          <Field label="اسم المستخدم" hint="3–24 خانة: حروف وأرقام ونقطة وشرطة فقط">
            <input className="input" value={username} onChange={(event) => setUsername(event.target.value)} required minLength={3} maxLength={24} placeholder="player_one" autoComplete="username" />
          </Field>
          <Field label="الاسم الظاهر (اختياري)">
            <input className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} placeholder="الاسم الذي يراه الآخرون" />
          </Field>
          <Field label="البريد الإلكتروني (اختياري)" hint="مفيد لاستعادة الحساب، ويمكن التسجيل بدونه">
            <input className="input" type="email" dir="ltr" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" />
          </Field>
          <Field label="كلمة المرور" hint="8 خانات على الأقل">
            <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} placeholder="••••••••" autoComplete="new-password" />
          </Field>

          <label className="flex cursor-pointer items-start gap-2 text-sm text-muted">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={accept} onChange={(event) => setAccept(event.target.checked)} />
            <span>
              أوافق على <Link href="/terms" className="font-bold text-brand hover:underline">شروط الاستخدام</Link> و{' '}
              <Link href="/privacy" className="font-bold text-brand hover:underline">سياسة الخصوصية</Link>.
            </span>
          </label>

          {error ? (
            <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm font-bold text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn btn-primary justify-center" disabled={busy}>
            {busy ? 'جارٍ الإنشاء…' : 'إنشاء الحساب'}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-muted">
          لديك حساب؟{' '}
          <Link href="/login" className="font-bold text-brand hover:underline">سجّل دخولك</Link>
        </p>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-bold text-ink">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}
