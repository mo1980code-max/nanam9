'use client';

/**
 * /admin/reports — إدارة البلاغات.
 *
 * لماذا لا تكفي «حذف التعليق» وحدها:
 * - البلاغ سجلٌ بحد ذاته (من أبلغ عن ماذا ولماذا). حذفه يمحو الدليل.
 *   القرار هنا ليس حذفًا بل «إغلاق البلاغ» بحالة واضحة: اتُّخذ إجراء
 *   أو رُفض — مع ملاحظةٍ تظهر للمُبلِّغ. بهذا يبقى التتبع كاملًا لسجل
 *   النشاط وتبقى الثقة.
 * - التعليقات التي تتجاوز عتبة البلاغات تُخفى تلقائيًا حتى قبل أن يراها
 *   مشرف (انظر social.service)، لذا هذه الصفحة للحُكم البشري لا للإسعاف.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/client-api';

type ReportRow = {
  id: string;
  reporterId: string | null;
  targetKind: string;
  targetId: string;
  reason: string;
  details: string | null;
  status: string; // open | reviewing | action_taken | dismissed
  moderatorId: string | null;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
  // denormalised names from the DB join
  reporterName?: string | null;
  moderatorName?: string | null;
  reporter?: { id: string; username: string } | null;
  moderator?: { id: string; username: string } | null;
  // the sql alias variant
  [k: string]: unknown;
};

const PER_PAGE = 20;
const nf = new Intl.NumberFormat('ar-EG');
const df = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });

const STATUS_LABELS: Record<string, string> = {
  open: 'مفتوح',
  reviewing: 'قيد المراجعة',
  action_taken: 'اتُّخذ إجراء',
  dismissed: 'مرفوض',
};
const STATUS_STYLES: Record<string, string> = {
  open: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  reviewing: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  action_taken: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  dismissed: 'bg-zinc-500/10 text-zinc-500',
};
const REASON_LABELS: Record<string, string> = {
  spam: 'بريد عشوائي',
  harassment: 'مضايقة',
  hate: 'كراهية',
  sexual: 'محتوى جنسي',
  violence: 'عنف',
  illegal: 'غير قانوني',
  copyright: 'حقوق نشر',
  misleading: 'مضلل',
  other: 'أخرى',
};

const RESOLVE_STATUSES = [
  { value: 'action_taken', label: 'اتُّخذ إجراء — أُغلق البلاغ بعد تنفيذ إجراء' },
  { value: 'dismissed', label: 'مرفوض — البلاغ لا يستدعي إجراءً' },
  { value: 'reviewing', label: 'قيد المراجعة — احتفظ به مفتوحًا للمتابعة' },
] as const;

export default function ReportsManagerPage() {
  const [items, setItems] = useState<ReportRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('any');
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const [resolving, setResolving] = useState<ReportRow | null>(null);
  const [resolveStatus, setResolveStatus] = useState<string>('action_taken');
  const [resolution, setResolution] = useState('');
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveError, setResolveError] = useState('');

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), perPage: String(PER_PAGE) });
    if (status !== 'any') params.set('status', status);
    const { status: code, payload } = await apiFetch<ReportRow>(`/admin/reports?${params.toString()}`);
    if (code === 200) {
      // ResponseInterceptor moves pagination to meta, rows to data.items
      const body = payload as unknown as { data?: { items?: ReportRow[] }; meta?: { pagination?: { total?: number } } };
      setItems(body.data?.items ?? []);
      setTotal(body.meta?.pagination?.total ?? 0);
    }
    setLoaded(true);
  }, [page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const openResolve = (r: ReportRow) => {
    setResolving(r);
    setResolveStatus(r.status === 'open' ? 'action_taken' : r.status);
    // default to a sensible closing status, not whatever the row already is
    if (r.status === 'open' || r.status === 'reviewing') setResolveStatus('action_taken');
    setResolution(r.resolution ?? '');
    setResolveError('');
  };

  const doResolve = async () => {
    if (!resolving) return;
    if (resolveStatus === 'open') {
      setResolveError('لا يمكن إعادة البلاغ إلى «مفتوح» من هنا.');
      return;
    }
    setResolveBusy(true);
    setResolveError('');
    const { status: code, payload } = await apiFetch(`/admin/reports/${resolving.id}/resolve`, {
      method: 'POST',
      body: { status: resolveStatus, resolution: resolution.trim() || undefined },
    });
    setResolveBusy(false);
    if (code === 200) {
      setResolving(null);
      setResolution('');
      setNotice({ tone: 'ok', text: `أُغلق البلاغ #${resolving.id.slice(0, 8)}… بحالة «${STATUS_LABELS[resolveStatus] ?? resolveStatus}».` });
      await load();
    } else {
      setResolveError(errorMessage(code, payload as never) + (payload?.error?.message ? ` — ${payload.error.message}` : ''));
    }
  };

  const reporterLabel = (r: ReportRow): string => {
    const n = (r.reporterName as string | null) ?? r.reporter?.username ?? null;
    if (n) return `@${n}`;
    return r.reporterId ? r.reporterId.slice(0, 8) + '…' : 'مجهول';
  };
  const moderatorLabel = (r: ReportRow): string | null => {
    const n = (r.moderatorName as string | null) ?? r.moderator?.username ?? null;
    if (n) return `@${n}`;
    return r.moderatorId ? r.moderatorId.slice(0, 8) + '…' : null;
  };

  return (
    <div className="grid gap-4">
      {/* toolbar */}
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <label className="grid gap-1">
          <span className="text-[10px] font-bold text-muted">حالة البلاغ</span>
          <select className="input !py-2 text-sm" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="any">كل الحالات</option>
            <option value="open">مفتوحة</option>
            <option value="reviewing">قيد المراجعة</option>
            <option value="action_taken">اتُّخذ إجراء</option>
            <option value="dismissed">مرفوضة</option>
          </select>
        </label>
        <button type="button" onClick={() => void load()} className="btn btn-ghost text-xs">↻ تحديث</button>
        <p className="ms-auto text-[11px] leading-5 text-muted">
          {nf.format(total)} بلاغًا · الحالات المفتوحة تظهر أولًا · الإخفاء التلقائي عند {nf.format(3)} بلاغات على التعليق
        </p>
      </div>

      {notice && (
        <div className={`rounded-xl border px-4 py-3 text-sm font-bold ${notice.tone === 'ok' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300'}`}>
          {notice.text}
        </div>
      )}

      {!loaded ? (
        <div className="grid gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
      ) : items.length === 0 ? (
        <div className="card grid place-items-center px-6 py-14 text-center">
          <p className="mb-2 text-3xl" aria-hidden>🚩</p>
          <p className="text-sm font-bold text-ink">لا بلاغات مطابقة</p>
          <p className="mt-1 max-w-md text-xs leading-5 text-muted">
            {status === 'any'
              ? 'لا بلاغات بعد — وهذا جيّد. عندما يُبلغ مستخدم عن تعليق أو لعبة أو قائمة، سيظهر هنا بأحدث البلاغات أولًا ويمكنك إغلاقه مع ملاحظة للمُبلِّغ.'
              : `لا بلاغات بحالة «${STATUS_LABELS[status] ?? status}». جرّب «كل الحالات».`}
          </p>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] text-muted">
                <th className="px-4 py-3 text-start font-bold">البلاغ</th>
                <th className="px-4 py-3 text-start font-bold">الهدف</th>
                <th className="px-4 py-3 text-start font-bold">السبب</th>
                <th className="px-4 py-3 text-start font-bold">الحالة</th>
                <th className="px-4 py-3 text-start font-bold">المُبلِّغ</th>
                <th className="px-4 py-3 text-start font-bold">المُشرف</th>
                <th className="px-4 py-3 text-start font-bold">التاريخ</th>
                <th className="px-3 py-3 text-start font-bold">قرار</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3">
                    <span className="font-mono text-[11px] font-bold text-ink" dir="ltr">{r.id.slice(0, 8)}…</span>
                    {r.details && <p className="mt-1 max-w-[22ch] truncate text-xs text-muted" title={r.details}>{r.details}</p>}
                    {r.resolution && <p className="mt-1 max-w-[22ch] truncate text-xs text-emerald-600" title={r.resolution}>↳ {r.resolution}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded bg-surface-2 px-2 py-1 font-mono text-[11px] font-bold text-ink" dir="ltr">{r.targetKind}</span>
                    <span className="ms-1 font-mono text-[11px] text-muted" dir="ltr">{r.targetId.slice(0, 10)}…</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-bold text-ink">{REASON_LABELS[r.reason] ?? r.reason}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS_STYLES[r.status] ?? 'bg-surface-2 text-muted'}`}>
                      {STATUS_LABELS[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted" dir="ltr">{reporterLabel(r)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted" dir="ltr">{moderatorLabel(r) ?? '—'}</td>
                  <td className="px-4 py-3 text-[11px] leading-5 text-muted">
                    <span className="block">{df.format(new Date(r.createdAt))}</span>
                    {r.resolvedAt && <span className="block text-emerald-600">حُل {df.format(new Date(r.resolvedAt))}</span>}
                  </td>
                  <td className="px-3 py-3">
                    {r.status === 'open' || r.status === 'reviewing' ? (
                      <button type="button" onClick={() => openResolve(r)} className="btn btn-primary !px-3 !py-1 text-[11px]">معالجة</button>
                    ) : (
                      <button type="button" onClick={() => openResolve(r)} className="btn btn-ghost !px-3 !py-1 text-[11px]">مراجعة</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3">
            <span className="text-xs text-muted">صفحة {nf.format(page)} من {nf.format(totalPages)} · {nf.format(total)} إجمالي</span>
            <div className="flex gap-1.5">
              <button type="button" className="btn btn-ghost !px-3 !py-1.5 text-xs" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← السابق</button>
              <button type="button" className="btn btn-ghost !px-3 !py-1.5 text-xs" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>التالي →</button>
            </div>
          </div>
        </div>
      )}

      {/* resolve modal */}
      {resolving && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal onClick={() => setResolving(null)}>
          <div className="card w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-lg font-black text-ink">إغلاق البلاغ</h2>
            <p className="mb-4 font-mono text-xs text-muted" dir="ltr">{resolving.id} · {resolving.targetKind}:{resolving.targetId.slice(0, 12)}…</p>
            {resolveError && <p className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs font-bold text-red-600">{resolveError}</p>}
            <div className="grid gap-3">
              <label className="grid gap-1">
                <span className="text-[10px] font-bold text-muted">القرار</span>
                <select className="input !py-2 text-sm" value={resolveStatus} onChange={(e) => setResolveStatus(e.target.value)}>
                  {RESOLVE_STATUSES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <label className="grid gap-1">
                <span className="text-[10px] font-bold text-muted">ملاحظة للمُبلِّغ (اختياري — ٥٠٠ حرف)</span>
                <textarea className="input min-h-24 !py-2 text-sm" value={resolution} onChange={(e) => setResolution(e.target.value)} maxLength={500} placeholder="مثال: حُذف التعليق المُسيء وتم تنبيه صاحبه. شكرًا لإبلاغك." />
                <span className="text-[10px] text-muted">{resolution.length}/500</span>
              </label>
              <p className="text-[11px] leading-5 text-muted">البلاغ لا يُحذف — تُثبّت عليه حالته النهائية وهوية المشرف والوقت، ويُحفظ كل شيء في سجل النشاط.</p>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn btn-ghost text-xs" onClick={() => setResolving(null)}>إلغاء</button>
              <button type="button" className="btn btn-primary text-xs" disabled={resolveBusy} onClick={() => void doResolve()}>{resolveBusy ? '… جارٍ الحفظ' : 'حفظ القرار'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
