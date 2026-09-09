'use client';

/**
 * /admin/users — إدارة المستخدمين: الأدوار، الحظر، التعديل، والحذف الناعم.
 *
 * لماذا هذه الواجهة حتمية لبوابة ٢٠ ألف لعبة:
 * - بوابة بلا إدارة حسابات تتحول لأداة بريد عشوائي في أسبوع. البحث + التصفية
 *   (النجوم XP، الجماهير، قِدم الحساب) هي ما يستخدمه المشرف فعلًا لاكتشاف
 *   الحسابات الوهمية قبل أن تُفسد التوصيات.
 * - الحظر يبطل كل الجلسات فورًا (الخادم يفعل ذلك)، والحذف ناعم — التعليقات
 *   والتقييمات تبقى منسوخة. هذا يحمي السجل من «الثغرات» التي يستغلها
 *   المنافسون الأضعف لحذف الأدلة.
 * - لا واجهة دفع — الأدوار وحدها تحكم الصلاحيات (CASL). كل تغيير يُسجل في
 *   سجل النشاط ويمكن تتبّعه.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch, errorMessage } from '@/lib/client-api';

// ── types mirrored from the API (adminList/adminOne/adminUpdate) ─────────
type RoleBrief = { slug: string; name: string; level: number; permissions: string[] };
type AdminUser = {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  emailVerifiedAt: string | null;
  bio: string | null;
  avatarUrl: string | null;
  locale: string;
  status: string; // pending | active | banned | deleted
  role: { slug: string; name: string; level: number };
  premium: boolean;
  level: { level: number; xp: number; progress: number; xpIntoLevel: number; xpForNextLevel: number; nextLevelAt: number };
  counts: { plays: number; comments: number; favorites: number; playlists: number; badges: number };
  memberSince: string;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

type Envelope<T> = {
  data?: { items?: T[] };
  meta?: { pagination?: { total: number; totalPages: number } };
};

const PER_PAGE = 20;
const nf = new Intl.NumberFormat('ar-EG');
const df = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });

const STATUS_LABELS: Record<string, string> = {
  active: 'نشط',
  banned: 'محظور',
  pending: 'قيد المراجعة',
  deleted: 'محذوف',
};
const STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  banned: 'bg-red-500/10 text-red-600 dark:text-red-400',
  pending: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  deleted: 'bg-zinc-500/10 text-zinc-500',
};

const ROLE_STYLES: Record<string, string> = {
  'super-admin': 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
  admin: 'bg-brand-soft text-brand border-brand/20',
  editor: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
  moderator: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  user: 'bg-surface-2 text-muted border-[var(--border)]',
};

const SORT_OPTIONS = [
  { value: 'newest', label: 'الأحدث' },
  { value: 'xp', label: 'الأعلى نقاطًا' },
  { value: 'plays', label: 'الأكثر لعبًا' },
  { value: 'username', label: 'الأبجدية' },
] as const;

export default function UsersManagerPage() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<RoleBrief[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('any');
  const [role, setRole] = useState('any');
  const [sort, setSort] = useState<string>('newest');
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // ── modals ────────────────────────────────────────────────────────────
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [editForm, setEditForm] = useState({ displayName: '', email: '', bio: '', role: '', status: '', xp: '', revokeSessions: false });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const [banning, setBanning] = useState<AdminUser | null>(null);
  const [banReason, setBanReason] = useState('');
  const [banBusy, setBanBusy] = useState(false);
  const [banError, setBanError] = useState('');

  const loadRoles = useCallback(async () => {
    const { status: code, payload } = await apiFetch<{ items?: RoleBrief[] }>('/admin/users/roles');
    if (code === 200) {
      const items = (payload as { data?: { items?: RoleBrief[] } })?.data?.items
        ?? (payload as { data?: RoleBrief[] })?.data
        ?? [];
      if (Array.isArray(items)) setRoles(items as RoleBrief[]);
      else {
        // fallback: payload.data is the array itself via response interceptor quirk
        const alt = (payload as unknown as { data: RoleBrief[] })?.data;
        if (Array.isArray(alt)) setRoles(alt);
      }
    }
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), perPage: String(PER_PAGE), sort });
    if (q.trim()) params.set('q', q.trim());
    if (status !== 'any') params.set('status', status);
    if (role !== 'any') params.set('role', role);
    const { status: code, payload } = await apiFetch<AdminUser>(`/admin/users?${params.toString()}`);
    if (code === 200) {
      const body = payload as Envelope<AdminUser>;
      setItems(body.data?.items ?? []);
      setTotal(body.meta?.pagination?.total ?? 0);
    }
    setLoaded(true);
  }, [page, q, status, role, sort]);

  useEffect(() => {
    void loadRoles();
  }, [loadRoles]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const openEditor = (u: AdminUser) => {
    setEditing(u);
    setEditError('');
    setEditForm({
      displayName: u.displayName ?? '',
      email: u.email ?? '',
      bio: u.bio ?? '',
      role: u.role.slug,
      status: u.status,
      xp: String(u.level.xp),
      revokeSessions: false,
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    setEditSaving(true);
    setEditError('');
    const body: Record<string, unknown> = {};
    // only send what changed — the API's 409 (last super-admin) is clearer that way
    if (editForm.displayName.trim() !== (editing.displayName ?? '')) body.displayName = editForm.displayName.trim() || undefined;
    if (editForm.email.trim() !== editing.email) body.email = editForm.email.trim();
    if ((editForm.bio ?? '') !== (editing.bio ?? '')) body.bio = editForm.bio;
    if (editForm.role !== editing.role.slug) body.role = editForm.role;
    if (editForm.status !== editing.status) body.status = editForm.status;
    if (Number(editForm.xp) !== editing.level.xp) body.xp = Number(editForm.xp);
    if (editForm.revokeSessions) body.revokeSessions = true;
    if (Object.keys(body).length === 0) {
      setEditError('لا تغييرات لحفظها.');
      setEditSaving(false);
      return;
    }
    const { status: code, payload } = await apiFetch(`/admin/users/${editing.id}`, { method: 'PATCH', body });
    setEditSaving(false);
    if (code === 200) {
      setEditing(null);
      setNotice({ tone: 'ok', text: `حُدث حساب «${editing.username}» بنجاح.` });
      await load();
    } else {
      setEditError(errorMessage(code, payload as never) + (payload?.error?.message ? ` — ${payload.error.message}` : ''));
    }
  };

  const doBan = async () => {
    if (!banning) return;
    setBanBusy(true);
    setBanError('');
    const { status: code, payload } = await apiFetch(`/admin/users/${banning.id}/ban`, {
      method: 'POST',
      body: banReason.trim() ? { reason: banReason.trim() } : {},
    });
    setBanBusy(false);
    if (code === 200) {
      setBanning(null);
      setBanReason('');
      setNotice({ tone: 'ok', text: `حُظر «${banning.username}» وأُبطلت جلساته.` });
      await load();
    } else {
      setBanError(errorMessage(code, payload as never) + (payload?.error?.message ? ` — ${payload.error.message}` : ''));
    }
  };

  const doUnban = async (u: AdminUser) => {
    if (!window.confirm(`رفع الحظر عن «${u.username}»؟`)) return;
    setBusyId(u.id);
    const { status: code, payload } = await apiFetch(`/admin/users/${u.id}/unban`, { method: 'POST', body: {} });
    setBusyId(null);
    if (code === 200) {
      setNotice({ tone: 'ok', text: `رُفع الحظر عن «${u.username}».` });
      await load();
    } else setNotice({ tone: 'err', text: errorMessage(code, payload as never) });
  };

  const doDelete = async (u: AdminUser) => {
    if (!window.confirm(`حذف «${u.username}»؟ الحذف ناعم — بياناته وتعليقاته تبقى منسوبة، لكن الحساب يختفي من القوائم.`)) return;
    setBusyId(u.id);
    const { status: code, payload } = await apiFetch(`/admin/users/${u.id}`, { method: 'DELETE' });
    setBusyId(null);
    if (code === 200) {
      setNotice({ tone: 'ok', text: `حُذف «${u.username}» (حذف ناعم).` });
      await load();
    } else setNotice({ tone: 'err', text: errorMessage(code, payload as never) + (payload?.error?.message ? ` — ${payload.error.message}` : '') });
  };

  return (
    <div className="grid gap-4">
      {/* ── toolbar ───────────────────────────────────────────────────── */}
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <label className="grid gap-1">
          <span className="text-[10px] font-bold text-muted">بحث</span>
          <input
            className="input !py-2 w-52 text-sm"
            value={q}
            placeholder="اسم، بريد، أو معرف…"
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[10px] font-bold text-muted">الحالة</span>
          <select className="input !py-2 text-sm" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="any">كل الحالات</option>
            <option value="active">نشط</option>
            <option value="banned">محظور</option>
            <option value="pending">قيد المراجعة</option>
            <option value="deleted">محذوف</option>
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-[10px] font-bold text-muted">الدور</span>
          <select className="input !py-2 text-sm" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
            <option value="any">كل الأدوار</option>
            {roles.map((r) => (
              <option key={r.slug} value={r.slug}>{r.name} — {r.slug}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-[10px] font-bold text-muted">الترتيب</span>
          <select className="input !py-2 text-sm" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}>
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void load()} className="btn btn-ghost text-xs">↻ تحديث</button>
        <p className="ms-auto text-[11px] text-muted">{nf.format(total)} حسابًا · {roles.length} أدوار</p>
      </div>

      {notice && (
        <div className={`rounded-xl border px-4 py-3 text-sm font-bold ${notice.tone === 'ok' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300'}`}>
          {notice.text}
        </div>
      )}

      {/* ── table ─────────────────────────────────────────────────────── */}
      {!loaded ? (
        <div className="grid gap-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
      ) : items.length === 0 ? (
        <div className="card grid place-items-center px-6 py-14 text-center">
          <p className="mb-2 text-3xl" aria-hidden>👥</p>
          <p className="text-sm font-bold text-ink">لا حسابات مطابقة</p>
          <p className="mt-1 text-xs text-muted">وسّع البحث أو غيّر المرشحات.</p>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] text-muted">
                <th className="px-4 py-3 text-start font-bold">الحساب</th>
                <th className="px-4 py-3 text-start font-bold">الدور</th>
                <th className="px-4 py-3 text-start font-bold">الحالة</th>
                <th className="px-4 py-3 text-start font-bold">المستوى</th>
                <th className="px-4 py-3 text-start font-bold">نشاط</th>
                <th className="px-4 py-3 text-start font-bold">العضوية</th>
                <th className="px-3 py-3 text-start font-bold">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id} className={`border-b border-[var(--border)] last:border-0 ${u.deletedAt ? 'opacity-55' : ''}`}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-soft text-sm font-black text-brand" aria-hidden>
                        {(u.displayName ?? u.username).charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 leading-tight">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate font-bold text-ink">{u.displayName ?? u.username}</span>
                          <Link href={u.username ? `/u/${u.username}` : '#'} target="_blank" className="shrink-0 text-[11px] text-muted hover:text-brand" dir="ltr">@{u.username}</Link>
                        </span>
                        <span className="block truncate text-[11px] text-muted" dir="ltr">{u.email}</span>
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold ${ROLE_STYLES[u.role.slug] ?? ROLE_STYLES.user}`}>
                      {u.role.name}
                    </span>
                    <span className="ms-1 text-[10px] text-muted">Lv.{u.role.level}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${STATUS_STYLES[u.status] ?? 'bg-surface-2 text-muted'}`}>
                      {STATUS_LABELS[u.status] ?? u.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs font-bold tabular-nums text-ink">م {u.level.level}</span>
                    <span className="text-[11px] text-muted"> · {nf.format(u.level.xp)} نقطة</span>
                    <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
                      <span className="block h-full bg-brand" style={{ width: `${Math.max(4, u.level.progress)}%` }} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs tabular-nums text-muted">
                    <span className="font-bold text-ink">{nf.format(u.counts.plays)}</span> لعبة
                    <span className="mx-1">·</span>{u.counts.comments} تعليقات
                  </td>
                  <td className="px-4 py-3 text-[11px] leading-5 text-muted">
                    <span className="block">منذ {df.format(new Date(u.memberSince))}</span>
                    <span className="block">{u.lastLoginAt ? `آخر دخول ${df.format(new Date(u.lastLoginAt))}` : 'لم يسجل دخولًا بعد'}</span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap items-center gap-1">
                      <button type="button" onClick={() => openEditor(u)} className="btn btn-ghost !px-2.5 !py-1 text-[11px]" disabled={busyId === u.id}>تعديل</button>
                      {u.status === 'banned' ? (
                        <button type="button" onClick={() => void doUnban(u)} className="btn btn-ghost !px-2.5 !py-1 text-[11px] text-emerald-600" disabled={busyId === u.id}>رفع الحظر</button>
                      ) : (
                        <button type="button" onClick={() => { setBanning(u); setBanReason(''); setBanError(''); }} className="btn btn-ghost !px-2.5 !py-1 text-[11px] text-amber-600" disabled={busyId === u.id || u.deletedAt !== null}>حظر</button>
                      )}
                      <button type="button" onClick={() => void doDelete(u)} className="btn btn-ghost !px-2.5 !py-1 text-[11px] text-red-600" disabled={busyId === u.id || u.deletedAt !== null}>حذف</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* pagination */}
          <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3">
            <span className="text-xs text-muted">صفحة {nf.format(page)} من {nf.format(totalPages)} · {nf.format(total)} إجمالي</span>
            <div className="flex gap-1.5">
              <button type="button" className="btn btn-ghost !px-3 !py-1.5 text-xs" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← السابق</button>
              <button type="button" className="btn btn-ghost !px-3 !py-1.5 text-xs" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>التالي →</button>
            </div>
          </div>
        </div>
      )}

      {/* ── edit modal ─────────────────────────────────────────────────── */}
      {editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal onClick={() => setEditing(null)}>
          <div className="card max-h-[92vh] w-full max-w-lg overflow-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-lg font-black text-ink">تعديل «{editing.username}»</h2>
              <button type="button" onClick={() => setEditing(null)} className="btn btn-ghost !px-2.5 !py-1 text-xs">✕</button>
            </div>
            {editError && <p className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs font-bold text-red-600">{editError}</p>}
            <div className="grid gap-3">
              <label className="grid gap-1">
                <span className="text-[10px] font-bold text-muted">الاسم الظاهر</span>
                <input className="input !py-2 text-sm" value={editForm.displayName} onChange={(e) => setEditForm((f) => ({ ...f, displayName: e.target.value }))} placeholder="الاسم" />
              </label>
              <label className="grid gap-1">
                <span className="text-[10px] font-bold text-muted">البريد الإلكتروني</span>
                <input className="input !py-2 text-sm" dir="ltr" value={editForm.email} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} placeholder="name@example.com" />
              </label>
              <label className="grid gap-1">
                <span className="text-[10px] font-bold text-muted">نبذة (bio)</span>
                <textarea className="input min-h-20 !py-2 text-sm" value={editForm.bio} onChange={(e) => setEditForm((f) => ({ ...f, bio: e.target.value }))} placeholder="اختياري — ٤٠٠ حرف كحد أقصى" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">الدور</span>
                  <select className="input !py-2 text-sm" value={editForm.role} onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value }))}>
                    {roles.map((r) => <option key={r.slug} value={r.slug}>{r.name} ({r.slug})</option>)}
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-[10px] font-bold text-muted">الحالة</span>
                  <select className="input !py-2 text-sm" value={editForm.status} onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}>
                    <option value="active">نشط</option>
                    <option value="pending">قيد المراجعة</option>
                    <option value="banned">محظور</option>
                  </select>
                </label>
              </div>
              <label className="grid gap-1">
                <span className="text-[10px] font-bold text-muted">النقاط (XP) — المستوى يُحسب تلقائيًا</span>
                <input className="input !py-2 text-sm" dir="ltr" type="number" min={0} max={10_000_000} value={editForm.xp} onChange={(e) => setEditForm((f) => ({ ...f, xp: e.target.value }))} />
              </label>
              <label className="flex items-center gap-2 text-xs font-bold text-ink">
                <input type="checkbox" checked={editForm.revokeSessions} onChange={(e) => setEditForm((f) => ({ ...f, revokeSessions: e.target.checked }))} />
                إبطال كل الجلسات (يجبر تسجيل دخول جديد على كل الأجهزة)
              </label>
              <p className="text-[11px] leading-5 text-muted">التغييرات الخاضعة للصلاحيات فقط هي التي تُطبّق — إن حاولت رفع دورٍ فوق مستواك أو إزالة آخر مدير عام فسترى <code className="rounded bg-surface-2 px-1">403/409</code> موضّحًا.</p>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn btn-ghost text-xs" onClick={() => setEditing(null)}>إلغاء</button>
              <button type="button" className="btn btn-primary text-xs" disabled={editSaving} onClick={() => void saveEdit()}>{editSaving ? '… جارٍ الحفظ' : 'حفظ التغييرات'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── ban modal ──────────────────────────────────────────────────── */}
      {banning && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 backdrop-blur-sm" role="dialog" aria-modal onClick={() => setBanning(null)}>
          <div className="card w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-lg font-black text-ink">حظر «{banning.username}»</h2>
            <p className="mb-4 text-xs leading-5 text-muted">سيُحظر الحساب وتُبطل كل جلساته فورًا. سيُرى السبب عند محاولة دخوله التالية ويُسجّل في سجل النشاط.</p>
            {banError && <p className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs font-bold text-red-600">{banError}</p>}
            <label className="grid gap-1">
              <span className="text-[10px] font-bold text-muted">السبب (اختياري — ٣٠٠ حرف)</span>
              <textarea className="input min-h-24 !py-2 text-sm" value={banReason} onChange={(e) => setBanReason(e.target.value)} placeholder="مثال: بريد عشوائي / إساءة متكررة…" maxLength={300} />
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn btn-ghost text-xs" onClick={() => setBanning(null)}>إلغاء</button>
              <button type="button" className="btn bg-amber-500 text-white hover:bg-amber-600 text-xs" disabled={banBusy} onClick={() => void doBan()}>{banBusy ? '… جارٍ الحظر' : 'تأكيد الحظر'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
