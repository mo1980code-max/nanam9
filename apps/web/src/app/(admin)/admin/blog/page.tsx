'use client';

/**
 * /admin/blog — the blog manager, bilingual by design.
 *
 * The post editor carries the Arabic and English editions side by side because
 * the public site renders both: a post with an empty English edition simply
 * falls back to Arabic per field (title, excerpt, body), so translating is
 * incremental and never blocks publishing.
 *
 * Endpoints used (all pre-existing): GET/POST /admin/content/blog/posts,
 * PATCH/:ref, POST /:ref/publish, DELETE /:ref, POST /:ref/restore,
 * GET /admin/content/blog/categories for the category picker.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/client-api';

type AdminPost = {
  id: string;
  slug: string;
  title: string;
  titleEn: string | null;
  excerpt: string | null;
  excerptEn: string | null;
  body: string;
  bodyEn: string | null;
  coverImage: string | null;
  status: string;
  live: boolean;
  publishedAt: string | null;
  updatedAt: string;
  views: number;
  readingMinutes: number;
  deletedAt: string | null;
  category: { slug: string; name: string } | null;
  author: { username: string; displayName: string | null } | null;
  tags: { slug: string; name: string }[];
};

type BlogCategory = { id: string; slug: string; name: string };

type Envelope<T> = {
  data?: { items?: T[] } | T[];
  meta?: { pagination?: { total?: number } };
};

const PER_PAGE = 10;
const nf = new Intl.NumberFormat('ar-EG');

const STATUS_STYLES: Record<string, string> = {
  published: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  draft: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  scheduled: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  archived: 'bg-red-500/10 text-red-600 dark:text-red-400',
};
const STATUS_LABELS: Record<string, string> = {
  published: 'منشور',
  draft: 'مسودة',
  scheduled: 'مجدول',
  archived: 'مؤرشف',
};

const emptyForm = {
  title: '',
  titleEn: '',
  excerpt: '',
  excerptEn: '',
  body: '',
  bodyEn: '',
  coverImage: '',
  category: '',
  tags: '',
  status: 'draft',
};

/** The admin envelope puts rows in data.items, but POST/PATCH return the row itself. */
function rowsOf<T>(payload: unknown): T[] {
  const data = (payload as Envelope<T>)?.data;
  if (Array.isArray(data)) return data;
  return data?.items ?? [];
}

export default function BlogManagerPage() {
  const [items, setItems] = useState<AdminPost[]>([]);
  const [categories, setCategories] = useState<BlogCategory[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('any');
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // ── editor ────────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState<AdminPost | null>(null); // null = closed; 'new' handled via creating flag
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    const search = new URLSearchParams({ page: String(page), perPage: String(PER_PAGE), status });
    if (q.trim()) search.set('q', q.trim());
    const { status: code, payload } = await apiFetch<AdminPost[]>(`/admin/content/blog/posts?${search.toString()}`);
    if (code === 200) {
      setItems(rowsOf<AdminPost>(payload));
      setTotal((payload as Envelope<AdminPost>)?.meta?.pagination?.total ?? 0);
    }
    setLoaded(true);
  }, [page, q, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const { status: code, payload } = await apiFetch<BlogCategory[]>('/admin/content/blog/categories');
      if (code === 200) setCategories(rowsOf<BlogCategory>(payload));
    })();
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const openEditor = (post: AdminPost) => {
    setCreating(false);
    setEditing(post);
    setFormError('');
    setForm({
      title: post.title,
      titleEn: post.titleEn ?? '',
      excerpt: post.excerpt ?? '',
      excerptEn: post.excerptEn ?? '',
      body: post.body ?? '',
      bodyEn: post.bodyEn ?? '',
      coverImage: post.coverImage ?? '',
      category: post.category?.slug ?? '',
      tags: post.tags.map((t) => t.slug).join(', '),
      status: post.status,
    });
  };

  const openCreator = () => {
    setCreating(true);
    setEditing({} as AdminPost); // just marks "open"
    setFormError('');
    setForm(emptyForm);
  };

  const save = async () => {
    if (!form.title.trim() || !form.body.trim()) {
      setFormError('العنوان والنص العربي مطلوبان.');
      return;
    }
    setSaving(true);
    setFormError('');
    const body: Record<string, unknown> = {
      title: form.title.trim(),
      body: form.body,
      status: form.status,
      titleEn: form.titleEn.trim() || undefined,
      excerpt: form.excerpt.trim() || undefined,
      excerptEn: form.excerptEn.trim() || undefined,
      bodyEn: form.bodyEn.trim() || undefined,
      coverImage: form.coverImage.trim() || undefined,
      category: form.category || undefined,
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    };
    const { status: code, payload } = await apiFetch<AdminPost>(
      creating ? '/admin/content/blog/posts' : `/admin/content/blog/posts/${editing?.id}`,
      { method: creating ? 'POST' : 'PATCH', body },
    );
    setSaving(false);
    if (code === 200 || code === 201) {
      setEditing(null);
      setCreating(false);
      await load();
    } else {
      setFormError((payload as { message?: string })?.message || `تعذّر الحفظ (${code})`);
    }
  };

  const publishNow = async (post: AdminPost) => {
    setBusyId(post.id);
    const { status: code } = await apiFetch(`/admin/content/blog/posts/${post.id}/publish`, { method: 'POST', body: {} });
    if (code === 200) await load();
    setBusyId(null);
  };

  const remove = async (post: AdminPost) => {
    if (!window.confirm(`حذف «${post.title}»؟ يمكن استعادته من المؤرشف.`)) return;
    setBusyId(post.id);
    const { status: code } = await apiFetch(`/admin/content/blog/posts/${post.id}`, { method: 'DELETE' });
    if (code === 200) await load();
    setBusyId(null);
  };

  const restore = async (post: AdminPost) => {
    setBusyId(post.id);
    const { status: code } = await apiFetch(`/admin/content/blog/posts/${post.id}/restore`, { method: 'POST' });
    if (code === 200) await load();
    setBusyId(null);
  };

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    options: { textarea?: boolean; dir?: 'ltr' | 'rtl'; placeholder?: string; mono?: boolean } = {},
  ) => (
    <label className="grid gap-1">
      <span className="text-[10px] font-bold text-muted">{label}</span>
      {options.textarea ? (
        <textarea
          className={`input min-h-40 !py-2 font-mono text-[13px] leading-6`}
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
            placeholder="عنوان أو نص…"
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
            <option value="published">منشور</option>
            <option value="draft">مسودات</option>
            <option value="scheduled">مجدولة</option>
            <option value="archived">مؤرشفة</option>
          </select>
        </label>
        <button type="button" onClick={() => void load()} className="btn btn-ghost text-xs">
          ↻ تحديث
        </button>
        <button type="button" onClick={openCreator} className="btn btn-primary text-xs">
          + مقال جديد
        </button>
        <p className="ms-auto text-[11px] text-muted">{nf.format(total)} مقالًا</p>
      </div>

      {/* ------------------------------------------------------------ table */}
      {!loaded ? (
        <div className="grid gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
      ) : items.length === 0 ? (
        <div className="card grid place-items-center px-6 py-14 text-center">
          <p className="mb-2 text-3xl" aria-hidden>📝</p>
          <p className="text-sm font-bold text-ink">لا مقالات مطابقة</p>
          <p className="mt-1 text-xs text-muted">اكتب أول مقال بزر «+ مقال جديد».</p>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] text-muted">
                <th className="px-4 py-3 text-start font-bold">المقال</th>
                <th className="px-4 py-3 text-start font-bold">الحالة</th>
                <th className="px-4 py-3 text-start font-bold">التصنيف</th>
                <th className="px-4 py-3 text-start font-bold">الكاتب</th>
                <th className="px-4 py-3 text-start font-bold">مشاهدات</th>
                <th className="px-4 py-3 text-start font-bold">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {items.map((post) => (
                <tr key={post.id} className={`border-b border-[var(--border)] last:border-0 ${post.deletedAt ? 'opacity-60' : ''}`}>
                  <td className="max-w-md px-4 py-3">
                    <p className="truncate font-bold text-ink">{post.title}</p>
                    <p className="truncate text-[11px] text-muted" dir="ltr">{post.titleEn ?? '— بدون نسخة إنجليزية —'}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS_STYLES[post.status] ?? 'bg-surface-2 text-muted'}`}>
                      {STATUS_LABELS[post.status] ?? post.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">{post.category?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-xs text-muted">{post.author?.displayName || post.author?.username || '—'}</td>
                  <td className="px-4 py-3 text-xs font-bold tabular-nums text-ink">{nf.format(post.views)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button type="button" onClick={() => openEditor(post)} className="btn btn-ghost !px-2.5 !py-1 text-[11px]">
                        تعديل
                      </button>
                      {post.deletedAt ? (
                        <button type="button" disabled={busyId === post.id} onClick={() => void restore(post)} className="btn btn-ghost !px-2.5 !py-1 text-[11px] text-emerald-600">
                          استعادة
                        </button>
                      ) : post.status !== 'published' ? (
                        <>
                          <button type="button" disabled={busyId === post.id} onClick={() => void publishNow(post)} className="btn btn-ghost !px-2.5 !py-1 text-[11px] text-emerald-600">
                            نشر الآن
                          </button>
                          <button type="button" disabled={busyId === post.id} onClick={() => void remove(post)} className="btn btn-ghost !px-2.5 !py-1 text-[11px] text-red-600">
                            حذف
                          </button>
                        </>
                      ) : (
                        <button type="button" disabled={busyId === post.id} onClick={() => void remove(post)} className="btn btn-ghost !px-2.5 !py-1 text-[11px] text-red-600">
                          حذف
                        </button>
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
            className="card max-h-[90vh] w-full max-w-3xl overflow-y-auto p-6"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={creating ? 'مقال جديد' : `تعديل ${editing.title ?? ''}`}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <h2 className="text-lg font-black text-ink">{creating ? 'مقال جديد' : 'تعديل المقال'}</h2>
              <button type="button" onClick={() => setEditing(null)} className="btn btn-ghost !px-2 !py-1 text-sm" aria-label="إغلاق">✕</button>
            </div>

            <div className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                {field('العنوان (عربي) ★', form.title, (v) => setForm({ ...form, title: v }), { placeholder: 'لماذا انتصرت ألعاب HTML5' })}
                {field('Title (English)', form.titleEn, (v) => setForm({ ...form, titleEn: v }), { dir: 'ltr', placeholder: 'Why HTML5 Games Won' })}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {field('الموجز (عربي)', form.excerpt, (v) => setForm({ ...form, excerpt: v }), { textarea: true, placeholder: 'يُشتق من النص إن تُرك فارغًا' })}
                {field('Excerpt (English)', form.excerptEn, (v) => setForm({ ...form, excerptEn: v }), { textarea: true, dir: 'ltr' })}
              </div>
              {field('النص (Markdown عربي) ★', form.body, (v) => setForm({ ...form, body: v }), { textarea: true, placeholder: '## عنوان فرعي…' })}
              {field('Body (English Markdown)', form.bodyEn, (v) => setForm({ ...form, bodyEn: v }), { textarea: true, dir: 'ltr' })}

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">التصنيف</span>
                  <select className="input !py-2 text-sm" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
                    <option value="">— بدون —</option>
                    {categories.map((c) => (
                      <option key={c.slug} value={c.slug}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">الحالة</span>
                  <select className="input !py-2 text-sm" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
                    <option value="draft">مسودة</option>
                    <option value="published">منشور</option>
                    <option value="scheduled">مجدول</option>
                    <option value="archived">مؤرشف</option>
                  </select>
                </label>
                {field('غلاف (مسار)', form.coverImage, (v) => setForm({ ...form, coverImage: v }), { dir: 'ltr', placeholder: '/brand/blog-1.svg' })}
              </div>
              {field('الوسوم (مفصولة بفواصل)', form.tags, (v) => setForm({ ...form, tags: v }), { dir: 'ltr', placeholder: 'seo, performance' })}

              {formError && <p className="rounded-xl bg-red-500/10 p-3 text-xs font-bold text-red-600 dark:text-red-400">{formError}</p>}

              <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-4">
                <button type="button" disabled={saving} onClick={() => setEditing(null)} className="btn btn-ghost text-xs">
                  إلغاء
                </button>
                <button type="button" disabled={saving} onClick={() => void save()} className="btn btn-primary text-xs">
                  {saving ? 'جارٍ الحفظ…' : creating ? 'إنشاء المقال' : 'حفظ التعديلات'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
