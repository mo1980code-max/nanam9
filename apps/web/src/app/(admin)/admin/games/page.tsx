'use client';

/**
 * /admin/games — the games manager: the screen a portal operator lives in.
 *
 * Everything here rides on the existing admin API (list/search/filter, PATCH,
 * soft-delete, restore) — this page adds zero new endpoints. Notable choices:
 *
 * · The edit form is bilingual (title/description AR + EN side by side) because
 *   the public site is: the English fields are optional, and the portal falls
 *   back to Arabic per-field, so an operator can translate lazily.
 * · Quick toggles (publish, feature) PATCH one field directly — the common
 *   operations must not open a form.
 * · Deleting is soft (status=archived): the row stays for audit and can be
 *   restored. Switching "show deleted" reveals it with a restore button.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/client-api';
import { mediaUrl } from '@/lib/api';

type AdminGame = {
  id: string;
  slug: string;
  title: string;
  titleEn: string | null;
  description: string | null;
  descriptionEn: string | null;
  instructions: string | null;
  developer: string | null;
  status: string;
  featured: boolean;
  premium: boolean;
  ageRating: string;
  orientation: string;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  bannerUrl: string | null;
  plays: number;
  ratingAvg: number | null;
  ratingCount: number;
  deletedAt: string | null;
  updatedAt: string;
  categories: { slug: string; name: string }[];
  tags: { slug: string; name: string }[];
};

type Envelope<T> = {
  data?: { items?: T[] };
  meta?: { pagination?: { total?: number; totalPages?: number } };
};

const PER_PAGE = 15;
const nf = new Intl.NumberFormat('ar-EG');

const STATUS_LABELS: Record<string, string> = {
  published: 'منشورة',
  draft: 'مسودة',
  archived: 'مؤرشفة',
};
const STATUS_STYLES: Record<string, string> = {
  published: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  draft: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  archived: 'bg-red-500/10 text-red-600 dark:text-red-400',
};

const emptyForm = {
  title: '',
  titleEn: '',
  description: '',
  descriptionEn: '',
  instructions: '',
  developer: '',
  status: 'draft',
  featured: false,
  premium: false,
  ageRating: 'everyone',
  orientation: 'any',
  width: '',
  height: '',
  thumbnailUrl: '',
  bannerUrl: '',
  categories: '',
  tags: '',
};

export default function GamesManagerPage() {
  const [items, setItems] = useState<AdminGame[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('any');
  const [showDeleted, setShowDeleted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // ── editor state ──────────────────────────────────────────────────────────
  const [editing, setEditing] = useState<AdminGame | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    const search = new URLSearchParams({ page: String(page), perPage: String(PER_PAGE), status, sort: 'updated' });
    if (q.trim()) search.set('q', q.trim());
    if (showDeleted) search.set('includeDeleted', 'true');
    const { status: code, payload } = await apiFetch<AdminGame[]>(`/admin/games?${search.toString()}`);
    if (code === 200) {
      const body = payload as Envelope<AdminGame>;
      setItems(body.data?.items ?? []);
      setTotal(body.meta?.pagination?.total ?? 0);
    }
    setLoaded(true);
  }, [page, q, status, showDeleted]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  /** One-field PATCH used by the quick toggles; updates the row in place. */
  const patch = async (game: AdminGame, body: Record<string, unknown>) => {
    setBusyId(game.id);
    const { status: code } = await apiFetch(`/admin/games/${game.id}`, { method: 'PATCH', body });
    if (code === 200) await load();
    setBusyId(null);
  };

  const remove = async (game: AdminGame) => {
    if (!window.confirm(`حذف «${game.title}»؟ الحذف مؤرشف — يمكن استعادته لاحقًا.`)) return;
    setBusyId(game.id);
    const { status: code } = await apiFetch(`/admin/games/${game.id}`, { method: 'DELETE' });
    if (code === 200) await load();
    setBusyId(null);
  };

  const restore = async (game: AdminGame) => {
    setBusyId(game.id);
    const { status: code } = await apiFetch(`/admin/games/${game.id}/restore`, { method: 'POST' });
    if (code === 200) await load();
    setBusyId(null);
  };

  const openEditor = (game: AdminGame) => {
    setEditing(game);
    setFormError('');
    setForm({
      title: game.title,
      titleEn: game.titleEn ?? '',
      description: game.description ?? '',
      descriptionEn: game.descriptionEn ?? '',
      instructions: game.instructions ?? '',
      developer: game.developer ?? '',
      status: game.status,
      featured: game.featured,
      premium: game.premium,
      ageRating: game.ageRating,
      orientation: game.orientation,
      width: game.width != null ? String(game.width) : '',
      height: game.height != null ? String(game.height) : '',
      thumbnailUrl: game.thumbnailUrl ?? '',
      bannerUrl: game.bannerUrl ?? '',
      categories: game.categories.map((c) => c.slug).join(', '),
      tags: game.tags.map((t) => t.slug).join(', '),
    });
  };

  const save = async () => {
    if (!editing) return;
    if (!form.title.trim()) {
      setFormError('العنوان العربي مطلوب.');
      return;
    }
    setSaving(true);
    setFormError('');
    const split = (value: string) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    const body: Record<string, unknown> = {
      title: form.title.trim(),
      titleEn: form.titleEn.trim() || undefined,
      description: form.description.trim() || undefined,
      descriptionEn: form.descriptionEn.trim() || undefined,
      instructions: form.instructions.trim() || undefined,
      developer: form.developer.trim() || undefined,
      status: form.status,
      featured: form.featured,
      premium: form.premium,
      ageRating: form.ageRating,
      orientation: form.orientation,
      width: form.width ? Number(form.width) : undefined,
      height: form.height ? Number(form.height) : undefined,
      thumbnailUrl: form.thumbnailUrl.trim() || undefined,
      bannerUrl: form.bannerUrl.trim() || undefined,
      categories: split(form.categories),
      tags: split(form.tags),
    };
    const { status: code, payload } = await apiFetch<{ message?: string }>(`/admin/games/${editing.id}`, {
      method: 'PATCH',
      body,
    });
    setSaving(false);
    if (code === 200) {
      setEditing(null);
      await load();
    } else {
      const message = (payload as { message?: string })?.message;
      setFormError(message || `تعذّر الحفظ (${code})`);
    }
  };

  const field = (label: string, value: string, onChange: (v: string) => void, options: { textarea?: boolean; dir?: 'ltr' | 'rtl'; placeholder?: string } = {}) => (
    <label className="grid gap-1">
      <span className="text-[10px] font-bold text-muted">{label}</span>
      {options.textarea ? (
        <textarea
          className="input min-h-24 !py-2 text-sm"
          dir={options.dir}
          value={value}
          placeholder={options.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          className="input !py-2 text-sm"
          dir={options.dir}
          value={value}
          placeholder={options.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );

  return (
    <div className="grid gap-4">
      {/* ---------------------------------------------------------- toolbar */}
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <label className="grid gap-1">
          <span className="text-[10px] font-bold text-muted">بحث</span>
          <input
            className="input !py-2 w-56 text-sm"
            value={q}
            placeholder="عنوان أو معرّف…"
            onChange={(event) => {
              setQ(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[10px] font-bold text-muted">الحالة</span>
          <select
            className="input !py-2 text-sm"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="any">الكل</option>
            <option value="published">منشورة</option>
            <option value="draft">مسودات</option>
            <option value="archived">مؤرشفة</option>
          </select>
        </label>
        <label className="flex cursor-pointer items-center gap-2 pb-2 text-xs font-bold text-ink">
          <input type="checkbox" className="checkbox" checked={showDeleted} onChange={(event) => { setShowDeleted(event.target.checked); setPage(1); }} />
          إظهار المحذوفة
        </label>
        <button type="button" onClick={() => void load()} className="btn btn-ghost text-xs">
          ↻ تحديث
        </button>
        <p className="ms-auto text-[11px] text-muted">{nf.format(total)} لعبة</p>
      </div>

      {/* ------------------------------------------------------------ table */}
      {!loaded ? (
        <div className="grid gap-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
      ) : items.length === 0 ? (
        <div className="card grid place-items-center px-6 py-14 text-center">
          <p className="mb-2 text-3xl" aria-hidden>🎮</p>
          <p className="text-sm font-bold text-ink">لا ألعاب مطابقة</p>
          <p className="mt-1 text-xs text-muted">جرّب كلمة بحث أخرى أو وسّع مرشّح الحالة.</p>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] text-muted">
                <th className="px-4 py-3 text-start font-bold">اللعبة</th>
                <th className="px-4 py-3 text-start font-bold">الحالة</th>
                <th className="px-4 py-3 text-start font-bold">التصنيفات</th>
                <th className="px-4 py-3 text-start font-bold">التشغيلات</th>
                <th className="px-4 py-3 text-start font-bold">التقييم</th>
                <th className="px-4 py-3 text-start font-bold">مميزة</th>
                <th className="px-4 py-3 text-start font-bold">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {items.map((game) => (
                <tr key={game.id} className={`border-b border-[var(--border)] last:border-0 ${game.deletedAt ? 'opacity-60' : ''}`}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {game.thumbnailUrl ? (
                        <img src={mediaUrl(game.thumbnailUrl) ?? ''} alt="" className="h-10 w-14 shrink-0 rounded-lg bg-surface-2 object-cover" />
                      ) : (
                        <div className="grid h-10 w-14 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">🎮</div>
                      )}
                      <div className="min-w-0">
                        <p className="truncate font-bold text-ink">{game.title}</p>
                        <p className="truncate text-[11px] text-muted" dir="ltr">{game.titleEn ?? '— بدون عنوان إنجليزي —'}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS_STYLES[game.status] ?? 'bg-surface-2 text-muted'}`}>
                      {STATUS_LABELS[game.status] ?? game.status}
                    </span>
                  </td>
                  <td className="max-w-40 truncate px-4 py-3 text-xs text-muted">{game.categories.map((c) => c.name).join('، ') || '—'}</td>
                  <td className="px-4 py-3 text-xs font-bold tabular-nums text-ink">{nf.format(game.plays)}</td>
                  <td className="px-4 py-3 text-xs tabular-nums text-muted">
                    {game.ratingCount > 0 ? `★ ${game.ratingAvg?.toFixed(1) ?? '—'} (${nf.format(game.ratingCount)})` : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      disabled={busyId === game.id}
                      title={game.featured ? 'إزالة التمييز' : 'تمييز في الرئيسية'}
                      onClick={() => void patch(game, { featured: !game.featured })}
                      className={`text-lg leading-none transition hover:scale-110 ${game.featured ? 'text-amber-500' : 'text-muted/40'}`}
                    >
                      ★
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button type="button" onClick={() => openEditor(game)} className="btn btn-ghost !px-2.5 !py-1 text-[11px]">
                        تعديل
                      </button>
                      {game.deletedAt ? (
                        <button type="button" disabled={busyId === game.id} onClick={() => void restore(game)} className="btn btn-ghost !px-2.5 !py-1 text-[11px] text-emerald-600">
                          استعادة
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={busyId === game.id}
                            onClick={() => void patch(game, { status: game.status === 'published' ? 'draft' : 'published' })}
                            className="btn btn-ghost !px-2.5 !py-1 text-[11px]"
                          >
                            {game.status === 'published' ? 'إخفاء' : 'نشر'}
                          </button>
                          <button type="button" disabled={busyId === game.id} onClick={() => void remove(game)} className="btn btn-ghost !px-2.5 !py-1 text-[11px] text-red-600">
                            حذف
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------------------------------- pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="btn btn-ghost text-xs">
            السابق
          </button>
          <span className="text-xs font-bold tabular-nums text-muted">
            {nf.format(page)} / {nf.format(totalPages)}
          </span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="btn btn-ghost text-xs">
            التالي
          </button>
        </div>
      )}

      {/* ----------------------------------------------------------- editor */}
      {editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => !saving && setEditing(null)}>
          <div
            className="card max-h-[90vh] w-full max-w-2xl overflow-y-auto p-6"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`تعديل ${editing.title}`}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-black text-ink">تعديل اللعبة</h2>
                <p className="text-[11px] text-muted" dir="ltr">/{editing.slug}</p>
              </div>
              <button type="button" onClick={() => setEditing(null)} className="btn btn-ghost !px-2 !py-1 text-sm" aria-label="إغلاق">✕</button>
            </div>

            <div className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                {field('العنوان (عربي) ★', form.title, (v) => setForm({ ...form, title: v }), { placeholder: 'الثعبان توربو' })}
                {field('Title (English)', form.titleEn, (v) => setForm({ ...form, titleEn: v }), { dir: 'ltr', placeholder: 'Turbo Snake' })}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {field('الوصف (عربي)', form.description, (v) => setForm({ ...form, description: v }), { textarea: true })}
                {field('Description (English)', form.descriptionEn, (v) => setForm({ ...form, descriptionEn: v }), { textarea: true, dir: 'ltr' })}
              </div>
              {field('تعليمات اللعب', form.instructions, (v) => setForm({ ...form, instructions: v }), { textarea: true })}
              <div className="grid gap-3 sm:grid-cols-2">
                {field('المطوّر', form.developer, (v) => setForm({ ...form, developer: v }), { dir: 'ltr' })}
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">الحالة</span>
                  <select className="input !py-2 text-sm" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
                    <option value="published">منشورة</option>
                    <option value="draft">مسودة</option>
                    <option value="archived">مؤرشفة</option>
                  </select>
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">الاتجاه</span>
                  <select className="input !py-2 text-sm" value={form.orientation} onChange={(event) => setForm({ ...form, orientation: event.target.value })}>
                    <option value="any">أي اتجاه</option>
                    <option value="landscape">أفقي</option>
                    <option value="portrait">عمودي</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">الفئة العمرية</span>
                  <select className="input !py-2 text-sm" value={form.ageRating} onChange={(event) => setForm({ ...form, ageRating: event.target.value })}>
                    <option value="everyone">الجميع</option>
                    <option value="teen">مراهقون</option>
                    <option value="mature">ناضجون</option>
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {field('العرض', form.width, (v) => setForm({ ...form, width: v }), { dir: 'ltr', placeholder: '560' })}
                  {field('الارتفاع', form.height, (v) => setForm({ ...form, height: v }), { dir: 'ltr', placeholder: '560' })}
                </div>
              </div>
              {field('صورة مصغرة (مسار)', form.thumbnailUrl, (v) => setForm({ ...form, thumbnailUrl: v }), { dir: 'ltr', placeholder: '/games/x/thumb.svg' })}
              {field('بانر (مسار)', form.bannerUrl, (v) => setForm({ ...form, bannerUrl: v }), { dir: 'ltr' })}
              {field('التصنيفات (slugs مفصولة بفواصل)', form.categories, (v) => setForm({ ...form, categories: v }), { dir: 'ltr', placeholder: 'arcade, classic' })}
              {field('الوسوم (slugs مفصولة بفواصل)', form.tags, (v) => setForm({ ...form, tags: v }), { dir: 'ltr', placeholder: 'retro, high-score' })}

              <div className="flex flex-wrap gap-4">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-bold text-ink">
                  <input type="checkbox" className="checkbox" checked={form.featured} onChange={(event) => setForm({ ...form, featured: event.target.checked })} />
                  مميزة في الرئيسية
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs font-bold text-ink">
                  <input type="checkbox" className="checkbox" checked={form.premium} onChange={(event) => setForm({ ...form, premium: event.target.checked })} />
                  مميزة (premium)
                </label>
              </div>

              {formError && <p className="rounded-xl bg-red-500/10 p-3 text-xs font-bold text-red-600 dark:text-red-400">{formError}</p>}

              <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-4">
                <button type="button" disabled={saving} onClick={() => setEditing(null)} className="btn btn-ghost text-xs">
                  إلغاء
                </button>
                <button type="button" disabled={saving} onClick={() => void save()} className="btn btn-primary text-xs">
                  {saving ? 'جارٍ الحفظ…' : 'حفظ التعديلات'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
