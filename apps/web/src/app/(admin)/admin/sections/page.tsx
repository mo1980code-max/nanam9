'use client';

/**
 * /admin/sections — the drag-and-drop homepage builder.
 *
 * The public home page renders whatever this list says, in this order, within one
 * ISR window (~30s). That is the product promise: publishing a homepage change is
 * an editor action, not a deploy.
 *
 * DRAG-AND-DROP without a library: native HTML5 drag events give us dragstart/
 * dragenter/dragend, which is exactly enough for a vertical reorder list — and
 * every row also carries ▲▼ buttons, because touch devices and keyboard users
 * deserve the same feature (native DnD is mouse-only).
 *
 * Order is persisted with one call (POST /admin/sections/reorder {page, ids});
 * field edits are per-row upserts (POST /admin/sections with an id).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/client-api';

type Section = {
  id: string;
  page: string;
  kind: string;
  title: string | null;
  titleEn: string | null;
  subtitle: string | null;
  config: Record<string, unknown>;
  sortOrder: number;
  isVisible: boolean;
};

const KIND_LABELS: Record<string, string> = {
  hero: 'واجهة بطولية',
  carousel: 'شريط متحرك',
  category_grid: 'شبكة تصنيفات',
  tag_cloud: 'سحابة وسوم',
  leaderboard: 'متصدرون',
  banner: 'لافتة',
  html: 'HTML مخصص',
  popular: 'الأكثر لعبًا',
  recent: 'أضيف حديثًا',
  game_grid: 'شبكة ألعاب',
};

const KIND_SOURCES: Record<string, string[]> = {
  carousel: ['popular', 'newest', 'top_rated', 'most_liked', 'featured', 'random'],
  popular: ['popular', 'trending'],
  recent: ['newest', 'updated'],
  game_grid: ['newest', 'popular', 'top_rated', 'most_liked', 'featured', 'random'],
};

export default function SectionsBuilder() {
  const [page] = useState('home');
  const [sections, setSections] = useState<Section[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [orderDirty, setOrderDirty] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // per-row draft edits, keyed by section id
  const [drafts, setDrafts] = useState<Record<string, { title: string; limit: string; source: string; isVisible: boolean }>>({});
  // new-section form
  const [newKind, setNewKind] = useState('carousel');
  const [newTitle, setNewTitle] = useState('');

  const say = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const load = useCallback(async () => {
    const { status, payload } = await apiFetch<{ items?: Section[] } | Section[]>(`/admin/sections?page=${page}`);
    if (status === 200) {
      const data = (payload as { data?: { items?: Section[] } | Section[] }).data;
      const items = Array.isArray(data) ? data : (data?.items ?? []);
      const sorted = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
      setSections(sorted);
      setDrafts(
        Object.fromEntries(
          sorted.map((section) => [
            section.id,
            {
              title: section.title ?? '',
              limit: String(section.config?.limit ?? 8),
              source: String(section.config?.source ?? ''),
              isVisible: section.isVisible,
            },
          ]),
        ),
      );
      setOrderDirty(false);
    }
    setLoaded(true);
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const draftOf = (section: Section) =>
    drafts[section.id] ?? { title: section.title ?? '', limit: '8', source: '', isVisible: section.isVisible };

  const patchDraft = (id: string, patch: Partial<{ title: string; limit: string; source: string; isVisible: boolean }>) =>
    setDrafts((previous) => {
      const current = previous[id];
      if (!current) return previous;
      return { ...previous, [id]: { ...current, ...patch } };
    });

  // ── drag & drop ────────────────────────────────────────────────────────────
  const onDragStart = (index: number) => setDragIndex(index);
  const onDragEnter = (index: number) => {
    if (dragIndex === null || dragIndex === index) return;
    setSections((previous) => {
      const next = [...previous];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(index, 0, moved!);
      return next;
    });
    setDragIndex(index);
    setOrderDirty(true);
  };
  const onDragEnd = () => setDragIndex(null);

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= sections.length) return;
    setSections((previous) => {
      const next = [...previous];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
    setOrderDirty(true);
  };

  // ── writes ─────────────────────────────────────────────────────────────────
  const saveOrder = async () => {
    setBusy(true);
    const { status, payload } = await apiFetch('/admin/sections/reorder', {
      method: 'POST',
      body: { page, ids: sections.map((section) => section.id) },
    });
    setBusy(false);
    if (status === 200) {
      setOrderDirty(false);
      setSections((previous) => previous.map((section, index) => ({ ...section, sortOrder: index })));
      say('ok', 'حُفظ الترتيب — سيظهر على الرئيسية خلال ثوانٍ.');
    } else say('err', errorMessage(status, payload));
  };

  const saveRow = async (section: Section) => {
    const draft = draftOf(section);
    const config: Record<string, unknown> = { ...section.config };
    const limit = Number(draft.limit);
    if (Number.isFinite(limit) && limit > 0) config.limit = Math.min(48, Math.max(1, Math.trunc(limit)));
    if (draft.source) config.source = draft.source;
    const { status, payload } = await apiFetch('/admin/sections', {
      method: 'POST',
      body: { id: section.id, page, kind: section.kind, title: draft.title || undefined, config, isVisible: draft.isVisible },
    });
    if (status === 200) say('ok', `حُفظ قسم «${draft.title || (KIND_LABELS[section.kind] ?? section.kind)}».`);
    else say('err', errorMessage(status, payload));
  };

  const removeRow = async (section: Section) => {
    if (!window.confirm(`حذف قسم «${section.title || (KIND_LABELS[section.kind] ?? section.kind)}» من ${page}؟`)) return;
    const { status, payload } = await apiFetch(`/admin/sections/${section.id}`, { method: 'DELETE' });
    if (status === 200) {
      setSections((previous) => previous.filter((item) => item.id !== section.id));
      say('ok', 'حُذف القسم.');
    } else say('err', errorMessage(status, payload));
  };

  const toggleVisible = async (section: Section) => {
    const next = !draftOf(section).isVisible;
    patchDraft(section.id, { isVisible: next });
    const { status } = await apiFetch('/admin/sections', {
      method: 'POST',
      body: { id: section.id, page, kind: section.kind, title: section.title ?? undefined, isVisible: next },
    });
    if (status === 200) say('ok', next ? 'أصبح القسم ظاهرًا.' : 'أُخفي القسم (بقي محفوظًا).');
  };

  const addSection = async () => {
    setBusy(true);
    const { status, payload } = await apiFetch<{ id?: string }>('/admin/sections', {
      method: 'POST',
      body: {
        page,
        kind: newKind,
        title: newTitle.trim() || KIND_LABELS[newKind],
        config: { limit: 8, source: KIND_SOURCES[newKind]?.[0] ?? 'newest' },
        isVisible: true,
      },
    });
    setBusy(false);
    if (status === 200) {
      setNewTitle('');
      say('ok', 'أُضيف القسم — اسحبه إلى مكانه ثم احفظ الترتيب.');
      await load();
    } else say('err', errorMessage(status, payload));
  };

  const visibleCount = useMemo(() => sections.filter((section) => section.isVisible).length, [sections]);

  if (!loaded) return <div className="grid gap-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-24 rounded-2xl" />)}</div>;

  return (
    <div className="grid gap-5">
      {toast ? (
        <p
          role="status"
          className={`rounded-xl px-4 py-3 text-sm font-bold ${toast.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-red-500/10 text-red-600 dark:text-red-400'}`}
        >
          {toast.text}
        </p>
      ) : null}

      {/* ------------------------------------------------------------ toolbar */}
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm font-bold text-ink">
          صفحة <code dir="ltr">home</code> · {sections.length.toLocaleString('ar-EG')} قسمًا ·{' '}
          <span className="text-emerald-600 dark:text-emerald-400">{visibleCount.toLocaleString('ar-EG')} ظاهر</span>
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void load()} className="btn btn-ghost text-xs">
            ↻ إعادة تحميل
          </button>
          <button type="button" onClick={() => void saveOrder()} className="btn btn-primary text-xs" disabled={busy || !orderDirty}>
            💾 حفظ الترتيب {orderDirty ? '(تغييرات غير محفوظة)' : ''}
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------ the list */}
      <ul className="grid gap-3" aria-label="أقسام الصفحة الرئيسية">
        {sections.map((section, index) => {
          const draft = draftOf(section);
          const sources = KIND_SOURCES[section.kind];
          return (
            <li
              key={section.id}
              draggable
              onDragStart={() => onDragStart(index)}
              onDragEnter={() => onDragEnter(index)}
              onDragOver={(event) => event.preventDefault()}
              onDragEnd={onDragEnd}
              className={`card grid gap-3 p-4 transition-all ${dragIndex === index ? 'border-brand opacity-70 shadow-lg' : ''} ${!section.isVisible ? 'opacity-60' : ''}`}
            >
              <div className="flex items-center gap-3">
                <span className="cursor-grab select-none text-lg text-muted active:cursor-grabbing" title="اسحب لإعادة الترتيب" aria-hidden>
                  ⠿
                </span>
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-xs font-black text-muted">
                  {index + 1}
                </span>
                <span className="chip shrink-0 text-[11px]">{KIND_LABELS[section.kind] ?? section.kind}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-black text-ink">{section.title || '(بلا عنوان)'}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <button type="button" onClick={() => move(index, -1)} className="btn btn-ghost !px-2 text-xs" aria-label="أعلى">▲</button>
                  <button type="button" onClick={() => move(index, 1)} className="btn btn-ghost !px-2 text-xs" aria-label="أسفل">▼</button>
                  <button
                    type="button"
                    onClick={() => void toggleVisible(section)}
                    className={`btn !px-2.5 text-xs ${section.isVisible ? 'btn-primary' : 'btn-ghost'}`}
                    title={section.isVisible ? 'ظاهر — اضغط للإخفاء' : 'مخفي — اضغط للإظهار'}
                  >
                    {section.isVisible ? '👁 ظاهر' : ' مخفي'}
                  </button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px_150px_auto]">
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">العنوان العربي</span>
                  <input className="input !py-2 text-sm" value={draft.title} onChange={(event) => patchDraft(section.id, { title: event.target.value })} />
                </label>
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">عدد الألعاب</span>
                  <input className="input !py-2 text-sm" type="number" min={1} max={48} value={draft.limit} onChange={(event) => patchDraft(section.id, { limit: event.target.value })} />
                </label>
                {sources ? (
                  <label className="grid gap-1">
                    <span className="text-[10px] font-bold text-muted">المصدر</span>
                    <select className="input !py-2 text-sm" value={draft.source} onChange={(event) => patchDraft(section.id, { source: event.target.value })}>
                      {sources.map((source) => (
                        <option key={source} value={source}>
                          {source}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span />
                )}
                <div className="flex items-end gap-2">
                  <button type="button" onClick={() => void saveRow(section)} className="btn btn-ghost text-xs">حفظ</button>
                  <button type="button" onClick={() => void removeRow(section)} className="btn btn-ghost text-xs text-red-500 hover:bg-red-500/10">حذف</button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {/* ------------------------------------------------------------ add new */}
      <section className="card p-4" aria-labelledby="add-heading">
        <h2 id="add-heading" className="mb-3 text-sm font-black text-ink">إضافة قسم جديد</h2>
        <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)_auto]">
          <label className="grid gap-1">
            <span className="text-[10px] font-bold text-muted">النوع</span>
            <select className="input !py-2 text-sm" value={newKind} onChange={(event) => setNewKind(event.target.value)}>
              {Object.entries(KIND_LABELS).map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-[10px] font-bold text-muted">العنوان</span>
            <input className="input !py-2 text-sm" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="مثال: ألعاب العيد" />
          </label>
          <button type="button" onClick={() => void addSection()} className="btn btn-primary self-end text-xs" disabled={busy}>
            ＋ إضافة
          </button>
        </div>
        <p className="mt-3 text-[11px] leading-6 text-muted">
          القسم الجديد يُضاف آخر القائمة — اسحبه إلى مكانه ثم «حفظ الترتيب». التغييرات تظهر على الرئيسية خلال نافذة ISR (~30 ثانية) بدون أي نشر.
        </p>
      </section>
    </div>
  );
}
