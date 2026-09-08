'use client';

/**
 * /admin/ads — مدير الإعلانات.
 *
 * لماذا هذه الواجهة حتمية لبوابة إعلانية:
 * - كل موضع (header, in_feed, interstitial …) هو استعلام واحد مُفهرس
 *   `ads_placement_status_priority_idx` — لا تحميل كامل للجدول على كل مشاهدة صفحة.
 *   هذه الصفحة تكتب في نفس الجدول الذي تقرأه الصفحات العامة عبر `GET /api/ads?placement=…`
 *   لذا أي تغيير هنا ينعكس فورًا (بعد إبطال كاش Redis لكل موضع).
 * - الجدولة (startsAt/endsAt) تُحترم في SQL (`WHERE starts_at <= now() AND ends_at > now()`)
 *   فلا حاجة لمهمة cron توقف/تشغّل الإعلانات — النافذة هي القانون.
 * - بدون فوترة: لا خطط دفع، فقط مواضع وإعلانات HTML/صورة/AdSense. هذا قرار متعمّد
 *   (العميل طلب إزالة الفوترة مرتين) — البوابة تربح من الإعلانات، لا من الاشتراكات.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/client-api';

type AdRow = {
  id: string;
  name: string;
  placement: string;
  type: string;
  status: string;
  code: string | null;
  imageUrl: string | null;
  linkUrl: string | null;
  priority: number;
  startsAt: string | null;
  endsAt: string | null;
  impressions: number | string;
  clicks: number | string;
  targeting: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

const nf = new Intl.NumberFormat('ar-EG');
const df = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'short', timeStyle: 'short' });

const PLACEMENTS: { value: string; label: string }[] = [
  { value: 'header', label: 'الرأس (header)' },
  { value: 'header_bottom', label: 'أسفل الرأس' },
  { value: 'sidebar_top', label: 'شريط جانبي علوي' },
  { value: 'sidebar_bottom', label: 'شريط جانبي سفلي' },
  { value: 'in_feed', label: 'داخل القائمة' },
  { value: 'interstitial', label: 'بيني بين الألعاب' },
  { value: 'footer', label: 'التذييل' },
  { value: 'game_top', label: 'أعلى صفحة اللعبة' },
  { value: 'game_side', label: 'جانب اللعبة' },
  { value: 'game_bottom', label: 'أسفل اللعبة' },
  { value: 'blog_post', label: 'داخل مقال' },
  { value: 'preloader', label: 'شاشة التحميل' },
];

const TYPE_LABELS: Record<string, string> = {
  html: 'HTML',
  adsense: 'AdSense',
  google_ad_manager: 'GAM',
  prebid: 'Prebid',
  image: 'صورة',
  script: 'سكريبت',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'نشط',
  paused: 'موقوف',
  scheduled: 'مجدول',
  expired: 'منتهي',
  archived: 'مؤرشف',
};
const STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  paused: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  scheduled: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  expired: 'bg-zinc-500/10 text-zinc-500',
  archived: 'bg-red-500/10 text-red-600 dark:text-red-400',
};

const PLACEMENT_STYLES: Record<string, string> = {
  header: 'bg-violet-500/10 text-violet-600',
  in_feed: 'bg-sky-500/10 text-sky-600',
  interstitial: 'bg-amber-500/10 text-amber-600',
  sidebar_top: 'bg-emerald-500/10 text-emerald-600',
  footer: 'bg-zinc-500/10 text-zinc-500',
};

function placementLabel(v: string): string {
  return PLACEMENTS.find((p) => p.value === v)?.label ?? v;
}

const emptyForm = {
  name: '',
  placement: 'header',
  type: 'html',
  status: 'active',
  code: '',
  imageUrl: '',
  linkUrl: '',
  priority: '0',
  startsAt: '',
  endsAt: '',
  targeting: '',
};

function toIsoOrNull(local: string): string | null {
  if (!local.trim()) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fromIso(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    // datetime-local expects YYYY-MM-DDTHH:mm (no seconds, no Z)
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

export default function AdsManagerPage() {
  const [items, setItems] = useState<AdRow[]>([]);
  const [placement, setPlacement] = useState('any');
  const [status, setStatus] = useState('any');
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // ── form ───────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState<AdRow | null>(null); // null = closed, 'new' = creating
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (placement !== 'any') params.set('placement', placement);
    if (status !== 'any') params.set('status', status);
    const q = params.toString() ? `?${params.toString()}` : '';
    const { status: code, payload } = await apiFetch<{ items?: AdRow[] }>(`/admin/ads${q}`);
    if (code === 200) {
      const body = payload as unknown as { data?: { items?: AdRow[]; total?: number } | AdRow[] };
      const data = body.data as { items?: AdRow[] } | AdRow[] | undefined;
      const rows = Array.isArray(data) ? data : (data?.items ?? []);
      setItems(rows);
    }
    setLoaded(true);
  }, [placement, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const openCreate = () => {
    setCreating(true);
    setEditing({} as AdRow);
    setForm(emptyForm);
    setFormError('');
  };

  const openEdit = (row: AdRow) => {
    setCreating(false);
    setEditing(row);
    setFormError('');
    setForm({
      name: row.name,
      placement: row.placement,
      type: row.type,
      status: row.status,
      code: row.code ?? '',
      imageUrl: row.imageUrl ?? '',
      linkUrl: row.linkUrl ?? '',
      priority: String(row.priority),
      startsAt: fromIso(row.startsAt),
      endsAt: fromIso(row.endsAt),
      targeting: row.targeting && Object.keys(row.targeting).length ? JSON.stringify(row.targeting, null, 2) : '',
    });
  };

  const save = async () => {
    if (!form.name.trim()) {
      setFormError('الاسم مطلوب.');
      return;
    }
    if (form.type === 'image' && !form.imageUrl.trim()) {
      setFormError('إعلانات الصورة تتطلب رابط الصورة (imageUrl).');
      return;
    }
    let targeting: Record<string, unknown> | undefined;
    if (form.targeting.trim()) {
      try {
        const parsed = JSON.parse(form.targeting);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('object');
        targeting = parsed as Record<string, unknown>;
      } catch {
        setFormError('حقل الاستهداف (targeting) يجب أن يكون JSON object صحيح، مثل {"loggedOutOnly":true} أو اتركه فارغًا.');
        return;
      }
    }
    const startsIso = toIsoOrNull(form.startsAt);
    const endsIso = toIsoOrNull(form.endsAt);
    if (startsIso && endsIso && new Date(endsIso) <= new Date(startsIso)) {
      setFormError('تاريخ الانتهاء يجب أن يكون بعد تاريخ البدء.');
      return;
    }

    setSaving(true);
    setFormError('');
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      placement: form.placement,
      type: form.type,
      status: form.status,
      priority: Number(form.priority) || 0,
      code: form.code.trim() ? form.code : null,
      imageUrl: form.imageUrl.trim() ? form.imageUrl.trim() : null,
      linkUrl: form.linkUrl.trim() ? form.linkUrl.trim() : null,
      startsAt: startsIso,
      endsAt: endsIso,
    };
    if (targeting !== undefined) body.targeting = targeting;
    // For PATCH we could send only changed fields, but full payload is clearer for ads (small, flat)

    const url = creating ? '/admin/ads' : `/admin/ads/${editing?.id}`;
    const method = creating ? 'POST' : 'PATCH';
    const { status: code, payload } = await apiFetch<AdRow>(url, { method: method as 'POST' | 'PATCH', body });
    setSaving(false);
    if (code === 200 || code === 201) {
      setEditing(null);
      setCreating(false);
      setNotice({ tone: 'ok', text: creating ? 'أُنشئ الإعلان بنجاح.' : 'حُفظ التغييرات.' });
      await load();
    } else {
      setFormError(errorMessage(code, payload as never) + (payload?.error?.message ? ` — ${payload.error.message}` : ` (${code})`));
    }
  };

  const remove = async (row: AdRow) => {
    if (!window.confirm(`حذف «${row.name}» في موضع ${placementLabel(row.placement)}؟ لا يمكن التراجع.`)) return;
    setBusyId(row.id);
    const { status: code, payload } = await apiFetch(`/admin/ads/${row.id}`, { method: 'DELETE' });
    setBusyId(null);
    if (code === 200) {
      setNotice({ tone: 'ok', text: `حُذف «${row.name}».` });
      await load();
    } else setNotice({ tone: 'err', text: errorMessage(code, payload as never) });
  };

  const toggleStatus = async (row: AdRow) => {
    const next = row.status === 'active' ? 'paused' : 'active';
    setBusyId(row.id);
    const { status: code } = await apiFetch(`/admin/ads/${row.id}`, { method: 'PATCH', body: { status: next } });
    setBusyId(null);
    if (code === 200) await load();
  };

  return (
    <div className="grid gap-4">
      {/* toolbar */}
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <label className="grid gap-1">
          <span className="text-[10px] font-bold text-muted">الموضع</span>
          <select className="input !py-2 text-sm" value={placement} onChange={(e) => setPlacement(e.target.value)}>
            <option value="any">كل المواضع</option>
            {PLACEMENTS.map((p) => <option key={p.value} value={p.value}>{p.label} — {p.value}</option>)}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-[10px] font-bold text-muted">الحالة</span>
          <select className="input !py-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="any">كل الحالات</option>
            <option value="active">نشط</option>
            <option value="paused">موقوف</option>
            <option value="scheduled">مجدول</option>
            <option value="expired">منتهي</option>
            <option value="archived">مؤرشف</option>
          </select>
        </label>
        <button type="button" onClick={() => void load()} className="btn btn-ghost text-xs">↻ تحديث</button>
        <button type="button" onClick={openCreate} className="btn btn-primary text-xs">+ إعلان جديد</button>
        <p className="ms-auto text-[11px] leading-5 text-muted">
          {nf.format(items.length)} إعلانًا في العرض · 12 موضعًا متاحًا · الكاش يُبطل لكل موضع عند الحفظ
        </p>
      </div>

      {notice && (
        <div className={`rounded-xl border px-4 py-3 text-sm font-bold ${notice.tone === 'ok' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300'}`}>
          {notice.text}
        </div>
      )}

      {/* table */}
      {!loaded ? (
        <div className="grid gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
      ) : items.length === 0 ? (
        <div className="card grid place-items-center px-6 py-14 text-center">
          <p className="mb-2 text-3xl" aria-hidden>📢</p>
          <p className="text-sm font-bold text-ink">لا إعلانات مطابقة</p>
          <p className="mt-1 max-w-md text-xs leading-5 text-muted">أنشئ أول إعلان بزر «+ إعلان جديد» — اختر الموضع (header/sidebar/in_feed… ) وألصق كود AdSense أو HTML.</p>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[1080px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] text-muted">
                <th className="px-4 py-3 text-start font-bold">الإعلان</th>
                <th className="px-4 py-3 text-start font-bold">الموضع</th>
                <th className="px-4 py-3 text-start font-bold">النوع</th>
                <th className="px-4 py-3 text-start font-bold">الحالة</th>
                <th className="px-4 py-3 text-start font-bold">أولوية</th>
                <th className="px-4 py-3 text-start font-bold">إحصاءات</th>
                <th className="px-4 py-3 text-start font-bold">الجدولة</th>
                <th className="px-3 py-3 text-start font-bold">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="max-w-xs px-4 py-3">
                    <p className="truncate font-bold text-ink">{row.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted" dir="ltr">{row.code ? row.code.slice(0, 70).replace(/\s+/g, ' ') : row.imageUrl ?? '—'}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${PLACEMENT_STYLES[row.placement] ?? 'bg-surface-2 text-muted'}`}>{placementLabel(row.placement)}</span>
                    <span className="ms-1 font-mono text-[10px] text-muted" dir="ltr">{row.placement}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-bold text-ink">{TYPE_LABELS[row.type] ?? row.type}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS_STYLES[row.status] ?? 'bg-surface-2 text-muted'}`}>{STATUS_LABELS[row.status] ?? row.status}</span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs font-bold text-ink">{nf.format(row.priority)}</td>
                  <td className="px-4 py-3 text-xs tabular-nums text-muted">
                    <span className="font-bold text-ink">{nf.format(Number(row.impressions))}</span> ظهور · {nf.format(Number(row.clicks))} نقرة
                  </td>
                  <td className="px-4 py-3 text-[11px] leading-5 text-muted">
                    {row.startsAt || row.endsAt ? (
                      <>
                        <span className="block">{row.startsAt ? `من ${df.format(new Date(row.startsAt))}` : 'من الآن'}</span>
                        <span className="block">{row.endsAt ? `حتى ${df.format(new Date(row.endsAt))}` : 'بلا انتهاء'}</span>
                      </>
                    ) : (
                      <span>دائم</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap items-center gap-1">
                      <button type="button" onClick={() => openEdit(row)} className="btn btn-ghost !px-2.5 !py-1 text-[11px]" disabled={busyId === row.id}>تعديل</button>
                      <button type="button" onClick={() => void toggleStatus(row)} className={`btn btn-ghost !px-2.5 !py-1 text-[11px] ${row.status === 'active' ? 'text-amber-600' : 'text-emerald-600'}`} disabled={busyId === row.id}>
                        {row.status === 'active' ? 'إيقاف' : 'تفعيل'}
                      </button>
                      <button type="button" onClick={() => void remove(row)} className="btn btn-ghost !px-2.5 !py-1 text-[11px] text-red-600" disabled={busyId === row.id}>حذف</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-[var(--border)] px-4 py-3 text-xs text-muted">
            تلميح: الإعلان البيني (interstitial) يُعرض كل {nf.format(4)} جولات — القيمة من الإعدادات <code className="rounded bg-surface-2 px-1">games.interstitialEvery</code> في <code className="rounded bg-surface-2 px-1">/admin/settings</code>.
          </div>
        </div>
      )}

      {/* modal */}
      {editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal onClick={() => { setEditing(null); setCreating(false); }}>
          <div className="card max-h-[92vh] w-full max-w-xl overflow-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-lg font-black text-ink">{creating ? 'إعلان جديد' : `تعديل «${editing.name}»`}</h2>
              <button type="button" onClick={() => { setEditing(null); setCreating(false); }} className="btn btn-ghost !px-2.5 !py-1 text-xs">✕</button>
            </div>
            {formError && <p className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs font-bold text-red-600">{formError}</p>}
            <div className="grid gap-3">
              <label className="grid gap-1">
                <span className="text-[10px] font-bold text-muted">اسم الإعلان (للإدارة فقط)</span>
                <input className="input !py-2 text-sm" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="مثال: Header banner 728×90" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">الموضع</span>
                  <select className="input !py-2 text-sm" value={form.placement} onChange={(e) => setForm((f) => ({ ...f, placement: e.target.value }))}>
                    {PLACEMENTS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">النوع</span>
                  <select className="input !py-2 text-sm" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
                    <option value="html">HTML</option>
                    <option value="adsense">AdSense</option>
                    <option value="google_ad_manager">GAM</option>
                    <option value="prebid">Prebid</option>
                    <option value="image">صورة (imageUrl + linkUrl)</option>
                    <option value="script">سكريبت</option>
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">الحالة</span>
                  <select className="input !py-2 text-sm" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
                    <option value="active">نشط</option>
                    <option value="paused">موقوف</option>
                    <option value="scheduled">مجدول</option>
                    <option value="expired">منتهي</option>
                    <option value="archived">مؤرشف</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">الأولوية (أعلى = يظهر أولًا)</span>
                  <input className="input !py-2 text-sm" dir="ltr" type="number" min={0} max={1000} value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))} />
                </label>
              </div>

              <label className="grid gap-1">
                <span className="text-[10px] font-bold text-muted">كود الإعلان (HTML/JS/AdSense) — يُعرض كما هو في الموضع</span>
                <textarea className="input min-h-28 !py-2 font-mono text-xs leading-5" dir="ltr" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} placeholder={`<div style="background:#7c3aed;color:white;padding:16px;text-align:center">إعلان — header</div>\nأو كود AdSense كامل`} />
                <span className="text-[10px] text-muted">{form.code.length.toLocaleString('ar-EG')}/20٬000</span>
              </label>

              {form.type === 'image' && (
                <div className="grid gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
                  <label className="grid gap-1">
                    <span className="text-[10px] font-bold text-muted">رابط الصورة (imageUrl)</span>
                    <input className="input !py-2 text-sm" dir="ltr" value={form.imageUrl} onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))} placeholder="https://cdn.example/banner-300x250.png" />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-[10px] font-bold text-muted">رابط النقر (linkUrl)</span>
                    <input className="input !py-2 text-sm" dir="ltr" value={form.linkUrl} onChange={(e) => setForm((f) => ({ ...f, linkUrl: e.target.value }))} placeholder="https://example.com/offer" />
                  </label>
                </div>
              )}
              {form.type !== 'image' && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="grid gap-1">
                    <span className="text-[10px] font-bold text-muted">رابط الصورة (اختياري)</span>
                    <input className="input !py-2 text-sm" dir="ltr" value={form.imageUrl} onChange={(e) => setForm((f) => ({ ...f, imageUrl: e.target.value }))} placeholder="—" />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-[10px] font-bold text-muted">رابط النقر (اختياري)</span>
                    <input className="input !py-2 text-sm" dir="ltr" value={form.linkUrl} onChange={(e) => setForm((f) => ({ ...f, linkUrl: e.target.value }))} placeholder="—" />
                  </label>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">بداية العرض (اختياري)</span>
                  <input className="input !py-2 text-sm" type="datetime-local" value={form.startsAt} onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))} />
                </label>
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">نهاية العرض (اختياري)</span>
                  <input className="input !py-2 text-sm" type="datetime-local" value={form.endsAt} onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))} />
                </label>
              </div>

              <label className="grid gap-1">
                <span className="text-[10px] font-bold text-muted">الاستهداف (targeting JSON — اختياري)</span>
                <textarea className="input min-h-20 !py-2 font-mono text-xs" dir="ltr" value={form.targeting} onChange={(e) => setForm((f) => ({ ...f, targeting: e.target.value }))} placeholder={`{\n  "loggedOutOnly": false,\n  "categories": ["racing"],\n  "countries": ["JO","SA"]\n}`} />
              </label>

              <p className="text-[11px] leading-5 text-muted">يُحفظ الكود كما هو — المرشحات الحقيقية (التعقيم ضد XSS) على عاتق الواجهة الأمامية التي تعرض الإعلان داخل حاوية آمنة. النوافذ الزمنية تُحترم في الاستعلام، والكاش يُبطل لكل موضع.</p>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn btn-ghost text-xs" onClick={() => { setEditing(null); setCreating(false); }}>إلغاء</button>
              <button type="button" className="btn btn-primary text-xs" disabled={saving} onClick={() => void save()}>{saving ? '… جارٍ الحفظ' : creating ? 'إنشاء الإعلان' : 'حفظ التغييرات'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
