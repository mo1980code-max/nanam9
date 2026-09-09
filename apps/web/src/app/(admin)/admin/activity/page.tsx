'use client';

/**
 * /admin/activity — the audit trail.
 *
 * Every privileged write in the API logs one row here (actor, action, target,
 * before/after, ip). This page is a read-only window over it with the two filters
 * operators actually use: "what did this person do" and "what happened to this
 * kind of thing". Pagination is server-side; the list refreshes every minute so
 * an open tab stays useful during an incident.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/client-api';

type ActivityItem = {
  id: number | string;
  action: string;
  actor: { id: string; label: string } | null;
  targetKind: string | null;
  targetId: string | null;
  ip: string | null;
  createdAt: string;
};

const PER_PAGE = 20;
const nf = new Intl.NumberFormat('ar-EG');

// Values are PREFIXES of the real action vocabulary (family.action, singular and
// plural families both exist: game./games., category./categories.…).
const ACTION_GROUPS = [
  { value: '', label: 'كل الإجراءات' },
  { value: 'auth', label: 'دخول وحسابات (auth)' },
  { value: 'game', label: 'الألعاب (game…)' },
  { value: 'section', label: 'أقسام الصفحات (section)' },
  { value: 'categor', label: 'التصنيفات (category)' },
  { value: 'blog', label: 'المدونة (blog)' },
  { value: 'comment', label: 'التعليقات (comment)' },
  { value: 'report', label: 'البلاغات (report)' },
  { value: 'user', label: 'المستخدمون (user)' },
  { value: 'playlist', label: 'قوائم اللعب (playlist)' },
  { value: 'setting', label: 'الإعدادات (setting)' },
  { value: 'theme', label: 'السمات (theme)' },
  { value: 'redirect', label: 'التحويلات (redirect)' },
  { value: 'system', label: 'النظام (system)' },
];

const ACTION_COLORS: [RegExp, string][] = [
  [/delete|ban|hard/, 'bg-red-500/10 text-red-600 dark:text-red-400'],
  [/create|publish|import|upload/, 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'],
  [/update|patch|reorder|moderate|resolve/, 'bg-amber-500/10 text-amber-600 dark:text-amber-400'],
  [/login|logout|oauth/, 'bg-sky-500/10 text-sky-600 dark:text-sky-400'],
];

function colorFor(action: string): string {
  return ACTION_COLORS.find(([pattern]) => pattern.test(action))?.[1] ?? 'bg-surface-2 text-muted';
}

export default function ActivityPage() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const search = new URLSearchParams({ page: String(page), perPage: String(PER_PAGE) });
    if (action) search.set('action', action);
    if (actor.trim()) search.set('actor', actor.trim());
    const { status, payload } = await apiFetch<{ items?: ActivityItem[] }>(`/admin/activity?${search.toString()}`);
    if (status === 200) {
      // The response envelope keeps the rows in `data.items` but moves the
      // pagination block to `meta.pagination` — see ResponseInterceptor.
      const body = payload as {
        data?: { items?: ActivityItem[] };
        meta?: { pagination?: { total?: number } };
      };
      setItems(body.data?.items ?? []);
      setTotal(body.meta?.pagination?.total ?? 0);
    }
    setLoaded(true);
  }, [page, action, actor]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <div className="grid gap-4">
      {/* ------------------------------------------------------------ filters */}
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <label className="grid gap-1">
          <span className="text-[10px] font-bold text-muted">نوع الإجراء</span>
          <select
            className="input !py-2 text-sm"
            value={action}
            onChange={(event) => {
              setAction(event.target.value);
              setPage(1);
            }}
          >
            {ACTION_GROUPS.map((group) => (
              <option key={group.value} value={group.value}>
                {group.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-[10px] font-bold text-muted">المنفّذ</span>
          <input
            className="input !py-2 text-sm"
            value={actor}
            onChange={(event) => {
              setActor(event.target.value);
              setPage(1);
            }}
            placeholder="اسم المستخدم…"
          />
        </label>
        <button type="button" onClick={() => void load()} className="btn btn-ghost text-xs">
          ↻ تحديث
        </button>
        <p className="ms-auto text-[11px] text-muted">{nf.format(total)} سجلًا · تحديث تلقائي كل دقيقة</p>
      </div>

      {/* ------------------------------------------------------------ the log */}
      {!loaded ? (
        <div className="grid gap-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
      ) : items.length === 0 ? (
        <div className="card grid place-items-center px-6 py-14 text-center">
          <p className="mb-2 text-3xl" aria-hidden>🗒️</p>
          <p className="text-sm font-bold text-ink">لا سجلات مطابقة</p>
          <p className="mt-1 text-xs text-muted">جرّب توسيع المرشحات — أو أن النظام فعلاً هادئ اليوم.</p>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-start text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] text-muted">
                <th className="px-4 py-3 text-start font-bold">الوقت</th>
                <th className="px-4 py-3 text-start font-bold">المنفّذ</th>
                <th className="px-4 py-3 text-start font-bold">الإجراء</th>
                <th className="px-4 py-3 text-start font-bold">الهدف</th>
                <th className="px-4 py-3 text-start font-bold">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {items.map((item) => (
                <tr key={item.id} className="transition-colors hover:bg-surface-2">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">
                    {new Date(item.createdAt).toLocaleString('ar-EG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-4 py-3 text-xs font-bold text-ink">{item.actor?.label ?? 'النظام'}</td>
                  <td className="px-4 py-3">
                    <code dir="ltr" className={`rounded-full px-2.5 py-1 text-[10px] font-black ${colorFor(item.action)}`}>
                      {item.action}
                    </code>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {item.targetKind ? <span>{item.targetKind} · <code dir="ltr">{String(item.targetId).slice(0, 8)}</code></span> : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted" dir="ltr">
                    {item.ip ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------------------------------------ pager */}
      {totalPages > 1 ? (
        <nav className="flex items-center justify-center gap-2" aria-label="صفحات السجل">
          <button type="button" className="btn btn-ghost text-xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            السابق
          </button>
          <span className="text-xs font-bold text-muted">
            {nf.format(page)} / {nf.format(totalPages)}
          </span>
          <button type="button" className="btn btn-ghost text-xs" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            التالي
          </button>
        </nav>
      ) : null}
    </div>
  );
}
