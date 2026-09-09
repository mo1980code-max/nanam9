'use client';

/**
 * /admin/taxonomy — categories & tags manager.
 *
 * Categories: nested (unlimited depth), bilingual (name/nameEn), with icon,
 * colour, visibility and ordering. The tree is rendered flat with indentation
 * because that is how a menu is audited — "what will the visitor see, in what
 * order". Editing reuses the existing admin endpoints; nothing new on the API
 * except tag renaming (PATCH /admin/tags/:id), because a tag's display name
 * was the one thing that could not be corrected after creation.
 *
 * Tags: cheap rows keyed by slug. Create in bulk, rename bilingually, watch
 * games_count. No delete: tags with zero games disappear from every surface
 * anyway, and dangling references are worse than quiet rows.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/client-api';

type Category = {
  id: string;
  slug: string;
  name: string;
  nameEn: string | null;
  description: string | null;
  icon: string | null;
  color: string | null;
  gamesCount: number;
  isVisible: boolean;
  sortOrder: number;
  parent: { slug: string; name: string } | null;
  children: Category[];
};

type Tag = {
  id: string;
  slug: string;
  name: string;
  nameEn: string | null;
  gamesCount: number;
};

const nf = new Intl.NumberFormat('ar-EG');

/** Depth-first flattening of the category tree, keeping depth for indentation. */
function flatten(nodes: Category[], depth = 0): { node: Category; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children ?? [], depth + 1)]);
}

const emptyCategory = {
  name: '',
  nameEn: '',
  slug: '',
  parent: '',
  icon: '',
  color: '',
  sortOrder: '0',
  isVisible: true,
  description: '',
};

export default function TaxonomyPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagQuery, setTagQuery] = useState('');
  const [newTags, setNewTags] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');

  // ── category editor ───────────────────────────────────────────────────────
  const [catEditing, setCatEditing] = useState<Category | null>(null); // null = closed
  const [catCreating, setCatCreating] = useState(false);
  const [catForm, setCatForm] = useState(emptyCategory);
  const [catSaving, setCatSaving] = useState(false);
  const [catError, setCatError] = useState('');

  // ── tag editor ────────────────────────────────────────────────────────────
  const [tagEditing, setTagEditing] = useState<Tag | null>(null);
  const [tagForm, setTagForm] = useState({ name: '', nameEn: '' });
  const [tagSaving, setTagSaving] = useState(false);
  const [tagError, setTagError] = useState('');

  const load = useCallback(async () => {
    const [catsRes, tagsRes] = await Promise.all([
      apiFetch<Category[]>('/admin/categories'),
      apiFetch<Tag[]>(`/admin/tags?limit=200${tagQuery.trim() ? `&q=${encodeURIComponent(tagQuery.trim())}` : ''}`),
    ]);
    if (catsRes.status === 200) {
      const body = catsRes.payload as { data?: { items?: Category[] } };
      setCategories(body.data?.items ?? []);
    }
    if (tagsRes.status === 200) {
      const body = tagsRes.payload as { data?: { items?: Tag[] } };
      setTags(body.data?.items ?? []);
    }
    setLoaded(true);
  }, [tagQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 4000);
  };

  const flat = flatten(categories);

  const openCatEditor = (node: Category) => {
    setCatCreating(false);
    setCatEditing(node);
    setCatError('');
    setCatForm({
      name: node.name,
      nameEn: node.nameEn ?? '',
      slug: node.slug,
      parent: node.parent?.slug ?? '',
      icon: node.icon ?? '',
      color: node.color ?? '',
      sortOrder: String(node.sortOrder ?? 0),
      isVisible: node.isVisible,
      description: node.description ?? '',
    });
  };

  const openCatCreator = () => {
    setCatCreating(true);
    setCatEditing({} as Category);
    setCatError('');
    setCatForm(emptyCategory);
  };

  const saveCategory = async () => {
    if (!catForm.name.trim()) {
      setCatError('الاسم العربي مطلوب.');
      return;
    }
    setCatSaving(true);
    setCatError('');
    const body: Record<string, unknown> = {
      name: catForm.name.trim(),
      nameEn: catForm.nameEn.trim() || undefined,
      slug: catForm.slug.trim() || undefined,
      icon: catForm.icon.trim() || undefined,
      color: catForm.color.trim() || undefined,
      sortOrder: Number(catForm.sortOrder) || 0,
      isVisible: catForm.isVisible,
      description: catForm.description.trim() || undefined,
    };
    // Create takes a parent slug or nothing (root). Update takes 'null' to move to root.
    if (catForm.parent) body.parent = catForm.parent;
    else if (!catCreating) body.parent = 'null';
    const { status, payload } = await apiFetch<Category>(
      catCreating ? '/admin/categories' : `/admin/categories/${catEditing?.id}`,
      { method: catCreating ? 'POST' : 'PATCH', body },
    );
    setCatSaving(false);
    if (status === 200 || status === 201) {
      setCatEditing(null);
      flash(catCreating ? 'أُنشئ التصنيف ✓' : 'حُفظ التعديل ✓');
      await load();
    } else {
      setCatError((payload as { message?: string })?.message || `تعذّر الحفظ (${status})`);
    }
  };

  const removeCategory = async (node: Category) => {
    if (!window.confirm(`حذف «${node.name}»؟ أبناؤه ينتقلون لمستواه، وألعابه تبقى بلا تصنيف.`)) return;
    const { status } = await apiFetch(`/admin/categories/${node.id}`, { method: 'DELETE' });
    if (status === 200) {
      flash('حُذف التصنيف ✓');
      await load();
    }
  };

  const recount = async () => {
    const { status, payload } = await apiFetch('/admin/categories/recount', { method: 'POST', body: {} });
    if (status === 200) {
      const data = payload as { data?: { categories?: number; tags?: number } };
      flash(`أُعيد العدّ: ${nf.format(data.data?.categories ?? 0)} تصنيفًا و${nf.format(data.data?.tags ?? 0)} وسمًا ✓`);
      await load();
    }
  };

  const createTags = async () => {
    const list = newTags
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (!list.length) return;
    const { status } = await apiFetch('/admin/tags', { method: 'POST', body: { tags: list, scope: 'game' } });
    if (status === 200) {
      setNewTags('');
      flash(`أُضيفت/تحُقّقت ${nf.format(list.length)} وسمًا ✓`);
      await load();
    }
  };

  const saveTag = async () => {
    if (!tagEditing) return;
    if (!tagForm.name.trim()) {
      setTagError('الاسم مطلوب.');
      return;
    }
    setTagSaving(true);
    setTagError('');
    const { status, payload } = await apiFetch<Tag>(`/admin/tags/${tagEditing.id}`, {
      method: 'PATCH',
      body: { name: tagForm.name.trim(), nameEn: tagForm.nameEn.trim() },
    });
    setTagSaving(false);
    if (status === 200) {
      setTagEditing(null);
      flash('حُفظ الوسم ✓');
      await load();
    } else {
      setTagError((payload as { message?: string })?.message || `تعذّر الحفظ (${status})`);
    }
  };

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    options: { textarea?: boolean; dir?: 'ltr' | 'rtl'; placeholder?: string; type?: string } = {},
  ) => (
    <label className="grid gap-1">
      <span className="text-[10px] font-bold text-muted">{label}</span>
      {options.textarea ? (
        <textarea className="input min-h-20 !py-2 text-sm" dir={options.dir} value={value} placeholder={options.placeholder} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input
          className="input !py-2 text-sm"
          dir={options.dir}
          type={options.type ?? 'text'}
          value={value}
          placeholder={options.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );

  return (
    <div className="grid gap-4">
      {notice && <p className="rounded-xl bg-emerald-500/10 p-3 text-xs font-bold text-emerald-600 dark:text-emerald-400">{notice}</p>}

      {/* ══════════════════════════════════════════════════ categories */}
      <section className="grid gap-3">
        <header className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-black text-ink">🗂️ التصنيفات</h2>
          <span className="text-[11px] text-muted">{nf.format(flat.length)} تصنيفًا</span>
          <div className="ms-auto flex gap-2">
            <button type="button" onClick={() => void recount()} className="btn btn-ghost text-xs">
              ⟳ إعادة عدّ العدادات
            </button>
            <button type="button" onClick={() => void load()} className="btn btn-ghost text-xs">
              ↻ تحديث
            </button>
            <button type="button" onClick={openCatCreator} className="btn btn-primary text-xs">
              + تصنيف جديد
            </button>
          </div>
        </header>

        {!loaded ? (
          <div className="grid gap-2">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : flat.length === 0 ? (
          <div className="card grid place-items-center px-6 py-12 text-center">
            <p className="text-sm font-bold text-ink">لا تصنيفات بعد</p>
            <p className="mt-1 text-xs text-muted">أنشئ أول تصنيف — تظهر فورًا في قائمة الموقع.</p>
          </div>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] text-muted">
                  <th className="px-4 py-3 text-start font-bold">التصنيف</th>
                  <th className="px-4 py-3 text-start font-bold">English</th>
                  <th className="px-4 py-3 text-start font-bold">الألعاب</th>
                  <th className="px-4 py-3 text-start font-bold">الترتيب</th>
                  <th className="px-4 py-3 text-start font-bold">الظهور</th>
                  <th className="px-4 py-3 text-start font-bold">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {flat.map(({ node, depth }) => (
                  <tr key={node.id} className={`border-b border-[var(--border)] last:border-0 ${node.isVisible ? '' : 'opacity-55'}`}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2" style={{ marginInlineStart: `${depth * 1.4}rem` }}>
                        {depth > 0 && <span className="text-muted" aria-hidden>↳</span>}
                        {node.color ? <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: node.color }} /> : null}
                        <span className="font-bold text-ink">{node.name}</span>
                        <span className="text-[10px] text-muted" dir="ltr">/{node.slug}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted" dir="ltr">{node.nameEn ?? '—'}</td>
                    <td className="px-4 py-2.5 text-xs font-bold tabular-nums text-ink">{nf.format(node.gamesCount)}</td>
                    <td className="px-4 py-2.5 text-xs tabular-nums text-muted">{nf.format(node.sortOrder)}</td>
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        title={node.isVisible ? 'مرئي — اضغط للإخفاء' : 'مخفي — اضغط للإظهار'}
                        onClick={async () => {
                          const { status } = await apiFetch(`/admin/categories/${node.id}`, { method: 'PATCH', body: { isVisible: !node.isVisible } });
                          if (status === 200) await load();
                        }}
                        className={`text-base leading-none ${node.isVisible ? 'text-emerald-500' : 'text-muted/40'}`}
                      >
                        {node.isVisible ? '👁' : '🚫'}
                      </button>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <button type="button" onClick={() => openCatEditor(node)} className="btn btn-ghost !px-2.5 !py-1 text-[11px]">
                          تعديل
                        </button>
                        <button type="button" onClick={() => void removeCategory(node)} className="btn btn-ghost !px-2.5 !py-1 text-[11px] text-red-600">
                          حذف
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ══════════════════════════════════════════════════════ tags */}
      <section className="grid gap-3">
        <header className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-black text-ink">🏷️ الوسوم</h2>
          <span className="text-[11px] text-muted">{nf.format(tags.length)} وسمًا</span>
        </header>

        <div className="card flex flex-wrap items-end gap-3 p-4">
          <label className="grid gap-1">
            <span className="text-[10px] font-bold text-muted">بحث</span>
            <input
              className="input !py-2 w-48 text-sm"
              value={tagQuery}
              placeholder="اسم وسم…"
              onChange={(event) => setTagQuery(event.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-[10px] font-bold text-muted">إضافة وسوم (مفصولة بفواصل)</span>
            <div className="flex gap-2">
              <input
                className="input !py-2 w-64 text-sm"
                value={newTags}
                placeholder=" puzzle, two-player, retro "
                onChange={(event) => setNewTags(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createTags();
                }}
              />
              <button type="button" onClick={() => void createTags()} className="btn btn-primary text-xs">
                إضافة
              </button>
            </div>
          </label>
        </div>

        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] text-muted">
                <th className="px-4 py-3 text-start font-bold">الاسم</th>
                <th className="px-4 py-3 text-start font-bold">English</th>
                <th className="px-4 py-3 text-start font-bold">Slug</th>
                <th className="px-4 py-3 text-start font-bold">الألعاب</th>
                <th className="px-4 py-3 text-start font-bold"></th>
              </tr>
            </thead>
            <tbody>
              {tags.map((tag) => (
                <tr key={tag.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2.5 font-bold text-ink">{tag.name}</td>
                  <td className="px-4 py-2.5 text-xs text-muted" dir="ltr">{tag.nameEn ?? '—'}</td>
                  <td className="px-4 py-2.5 text-[11px] text-muted" dir="ltr">#{tag.slug}</td>
                  <td className="px-4 py-2.5 text-xs font-bold tabular-nums text-ink">{nf.format(tag.gamesCount)}</td>
                  <td className="px-4 py-2.5">
                    <button
                      type="button"
                      className="btn btn-ghost !px-2.5 !py-1 text-[11px]"
                      onClick={() => {
                        setTagEditing(tag);
                        setTagError('');
                        setTagForm({ name: tag.name, nameEn: tag.nameEn ?? '' });
                      }}
                    >
                      تعديل الأسماء
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ════════════════════════════════════════ category editor modal */}
      {catEditing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => !catSaving && setCatEditing(null)}>
          <div className="card max-h-[90vh] w-full max-w-xl overflow-y-auto p-6" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-black text-ink">{catCreating ? 'تصنيف جديد' : 'تعديل التصنيف'}</h3>
              <button type="button" onClick={() => setCatEditing(null)} className="btn btn-ghost !px-2 !py-1 text-sm" aria-label="إغلاق">✕</button>
            </div>
            <div className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                {field('الاسم (عربي) ★', catForm.name, (v) => setCatForm({ ...catForm, name: v }), { placeholder: 'أركيد' })}
                {field('Name (English)', catForm.nameEn, (v) => setCatForm({ ...catForm, nameEn: v }), { dir: 'ltr', placeholder: 'Arcade' })}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {field('Slug (إن تُرك فارغًا يُشتق)', catForm.slug, (v) => setCatForm({ ...catForm, slug: v }), { dir: 'ltr', placeholder: 'arcade' })}
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">التصنيف الأب</span>
                  <select className="input !py-2 text-sm" value={catForm.parent} onChange={(event) => setCatForm({ ...catForm, parent: event.target.value })}>
                    <option value="">— جذري —</option>
                    {flat
                      .filter(({ node }) => node.id !== catEditing?.id)
                      .map(({ node, depth }) => (
                        <option key={node.id} value={node.slug}>
                          {'— '.repeat(depth)}
                          {node.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {field('أيقونة (اسم/إيموجي)', catForm.icon, (v) => setCatForm({ ...catForm, icon: v }), { placeholder: '🕹️' })}
                {field('لون (Hex)', catForm.color, (v) => setCatForm({ ...catForm, color: v }), { dir: 'ltr', placeholder: '#7c3aed' })}
                {field('الترتيب', catForm.sortOrder, (v) => setCatForm({ ...catForm, sortOrder: v }), { dir: 'ltr', type: 'number' })}
              </div>
              {field('الوصف', catForm.description, (v) => setCatForm({ ...catForm, description: v }), { textarea: true })}
              <label className="flex cursor-pointer items-center gap-2 text-xs font-bold text-ink">
                <input type="checkbox" className="checkbox" checked={catForm.isVisible} onChange={(event) => setCatForm({ ...catForm, isVisible: event.target.checked })} />
                مرئي في الموقع
              </label>
              {catError && <p className="rounded-xl bg-red-500/10 p-3 text-xs font-bold text-red-600 dark:text-red-400">{catError}</p>}
              <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-4">
                <button type="button" disabled={catSaving} onClick={() => setCatEditing(null)} className="btn btn-ghost text-xs">إلغاء</button>
                <button type="button" disabled={catSaving} onClick={() => void saveCategory()} className="btn btn-primary text-xs">
                  {catSaving ? 'جارٍ الحفظ…' : catCreating ? 'إنشاء' : 'حفظ'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════ tag rename modal */}
      {tagEditing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => !tagSaving && setTagEditing(null)}>
          <div className="card w-full max-w-md p-6" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-black text-ink">تعديل الوسم <span className="text-muted" dir="ltr">#{tagEditing.slug}</span></h3>
              <button type="button" onClick={() => setTagEditing(null)} className="btn btn-ghost !px-2 !py-1 text-sm" aria-label="إغلاق">✕</button>
            </div>
            <div className="grid gap-3">
              {field('الاسم (عربي) ★', tagForm.name, (v) => setTagForm({ ...tagForm, name: v }))}
              {field('Name (English)', tagForm.nameEn, (v) => setTagForm({ ...tagForm, nameEn: v }), { dir: 'ltr' })}
              <p className="text-[11px] text-muted">الـ slug لا يتغير — هو المفتاح في الروابط والربط بالألعاب.</p>
              {tagError && <p className="rounded-xl bg-red-500/10 p-3 text-xs font-bold text-red-600 dark:text-red-400">{tagError}</p>}
              <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-4">
                <button type="button" disabled={tagSaving} onClick={() => setTagEditing(null)} className="btn btn-ghost text-xs">إلغاء</button>
                <button type="button" disabled={tagSaving} onClick={() => void saveTag()} className="btn btn-primary text-xs">
                  {tagSaving ? 'جارٍ الحفظ…' : 'حفظ'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
