'use client';

/**
 * Nested comments.
 *
 * THE TREE IS BUILT HERE, NOT IN SQL: the API returns a flat list with `parentId`, and
 * a recursive CTE per page view is the expensive way to do something a 30-line reducer
 * does in microseconds on 20 rows. Depth is capped for rendering so a reply loop cannot
 * produce 40 levels of indentation on a phone.
 *
 * GUEST COMMENTS are a setting (`games.guestComments`), not a decision hardcoded here.
 * When it is off, the composer asks for a sign-in instead — the moderation burden of
 * anonymous comments is real, and an operator should be able to close it without a
 * release.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { apiFetch, errorMessage, readCookie } from '@/lib/client-api';
import type { Comment } from '@/lib/api';

const MAX_DEPTH = 5;
const nf = new Intl.NumberFormat('ar-EG');

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(1, Math.floor((Date.now() - then) / 1000));
  const units: [number, string, string][] = [
    [60, 'ثانية', 'ثوانٍ'],
    [3600, 'دقيقة', 'دقائق'],
    [86400, 'ساعة', 'ساعات'],
    [604800, 'يوم', 'أيام'],
    [2_592_000, 'أسبوع', 'أسابيع'],
    [31_536_000, 'شهر', 'أشهر'],
  ];
  let previous = 1;
  for (const [limit, one, many] of units) {
    if (seconds < limit) {
      const value = Math.floor(seconds / previous);
      return `منذ ${nf.format(value)} ${value <= 10 ? many : one}`;
    }
    previous = limit;
  }
  return `منذ ${nf.format(Math.floor(seconds / 31_536_000))} سنة`;
}

type Node = Omit<Comment, 'children'> & { children: Node[] };

function buildTree(items: Comment[]): Node[] {
  const byId = new Map<string, Node>();
  items.forEach((item) => byId.set(item.id, { ...item, children: [] }));
  const roots: Node[] = [];
  byId.forEach((node) => {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });
  const sortNewest = (list: Node[]): Node[] =>
    list
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((node) => ({ ...node, children: sortNewest(node.children) }));
  return sortNewest(roots);
}

function CommentNode({
  node,
  depth,
  onReply,
  replyingTo,
  signedIn,
}: {
  node: Node;
  depth: number;
  onReply: (comment: Node) => void;
  replyingTo: string | null;
  signedIn: boolean;
}) {
  const author = node.author?.displayName || node.author?.username || 'زائر';
  const handle = node.author?.username;

  return (
    <li className="list-none">
      <article className="flex gap-3 py-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand to-accent text-sm font-black text-white">
          {author.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <header className="mb-1 flex flex-wrap items-center gap-2 text-xs">
            {handle ? (
              <Link href={`/u/${handle}`} className="font-black text-ink hover:text-brand">
                {author}
              </Link>
            ) : (
              <span className="font-black text-ink">{author}</span>
            )}
            <span className="text-muted">{timeAgo(node.createdAt)}</span>
          </header>
          <p className="whitespace-pre-wrap break-words text-sm leading-7 text-ink">{node.body}</p>
          <div className="mt-1.5 flex items-center gap-3 text-xs">
            {typeof node.likesCount === 'number' && node.likesCount > 0 ? (
              <span className="text-muted">👍 {nf.format(node.likesCount)}</span>
            ) : null}
            {depth < MAX_DEPTH ? (
              <button type="button" onClick={() => onReply(node)} className="font-bold text-brand hover:underline">
                رد
              </button>
            ) : null}
          </div>

          {replyingTo === node.id ? (
            <p className="mt-2 text-xs text-muted">
              {signedIn ? 'اكتب ردّك في المربع أدناه — سيظهر تحت هذا التعليق.' : 'سجّل الدخول للرد على التعليقات.'}
            </p>
          ) : null}

          {node.children.length ? (
            <ul className="mt-1 border-s-2 border-line ps-3">
              {node.children.map((child) => (
                <CommentNode
                  key={child.id}
                  node={child}
                  depth={depth + 1}
                  onReply={onReply}
                  replyingTo={replyingTo}
                  signedIn={signedIn}
                />
              ))}
            </ul>
          ) : null}
        </div>
      </article>
    </li>
  );
}

type Props = {
  gameSlug: string;
  initial: Comment[];
  total: number;
  guestComments: boolean;
  signedIn: boolean;
};

export function Comments({ gameSlug, initial, total, guestComments, signedIn }: Props) {
  const [items, setItems] = useState<Comment[]>(initial);
  const [body, setBody] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The page ships without comments (ISR must stay static); the first page of the
  // thread is pulled here, in the browser, once. A failure degrades to "no comments
  // yet", never to a broken page.
  useEffect(() => {
    if (initial.length > 0 || total <= 0) return;
    let cancelled = false;
    fetch(`/api/comments?game=${encodeURIComponent(gameSlug)}&limit=30`, { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const rows = (payload as { data?: { items?: Comment[] } } | null)?.data?.items;
        if (!cancelled && Array.isArray(rows)) setItems(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [gameSlug, initial.length, total]);

  const tree = useMemo(() => buildTree(items), [items]);
  const canPost = signedIn || guestComments;
  const hasSession = typeof document !== 'undefined' ? Boolean(readCookie('voltade_csrf')) : false;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (text.length < 2) {
      setMessage('اكتب تعليقًا من حرفين على الأقل.');
      return;
    }
    setBusy(true);
    setMessage(null);
    const { status, payload } = await apiFetch<Comment>('/comments', {
      method: 'POST',
      body: {
        game: gameSlug,
        body: text,
        parent: parent ?? undefined,
        authorName: !signedIn && authorName.trim() ? authorName.trim() : undefined,
      },
    });
    setBusy(false);
    if (!payload.ok || !payload.data) {
      setMessage(errorMessage(status, payload));
      return;
    }
    setItems([payload.data, ...items]);
    setBody('');
    setParent(null);
    setMessage('نُشر تعليقك ✓');
    window.setTimeout(() => setMessage(null), 4000);
  };

  return (
    <section className="card p-4 sm:p-5" aria-labelledby="comments-heading">
      <h2 id="comments-heading" className="mb-4 text-base font-black text-ink">
        التعليقات <span className="text-sm font-bold text-muted">({nf.format(total || items.length)})</span>
      </h2>

      {canPost ? (
        <form onSubmit={(event) => void submit(event)} className="mb-6 grid gap-2">
          {parent ? (
            <div className="flex items-center justify-between rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
              <span>ردّ على تعليق</span>
              <button type="button" onClick={() => setParent(null)} className="font-bold text-brand">
                إلغاء
              </button>
            </div>
          ) : null}
          {!signedIn && guestComments ? (
            <input
              value={authorName}
              onChange={(event) => setAuthorName(event.target.value.slice(0, 60))}
              placeholder="اسمك (يظهر مع التعليق)"
              className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-brand focus:bg-surface"
            />
          ) : null}
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value.slice(0, 2000))}
            rows={3}
            placeholder={hasSession || signedIn ? 'شاركنا رأيك في اللعبة…' : 'اكتب تعليقك كزائر…'}
            className="w-full resize-y rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm leading-7 text-ink placeholder:text-muted focus:border-brand focus:bg-surface"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted">{nf.format(body.length)} / ٢٠٠٠</span>
            <button type="submit" disabled={busy} className="btn btn-primary">
              {busy ? '…' : 'نشر التعليق'}
            </button>
          </div>
        </form>
      ) : (
        <p className="mb-6 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm text-muted">
          التعليق متاح للأعضاء فقط — <Link href="/login" className="font-bold text-brand">سجّل الدخول</Link> للمشاركة.
        </p>
      )}

      {message ? (
        <p role="status" className="mb-4 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm font-bold text-ink">
          {message}
        </p>
      ) : null}

      {tree.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">لا تعليقات بعد — كن أول من يكتب.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {tree.map((node) => (
            <CommentNode
              key={node.id}
              node={node}
              depth={0}
              replyingTo={parent}
              signedIn={signedIn}
              onReply={(comment) => {
                setParent(comment.id);
                if (!canPost) setMessage('سجّل الدخول للرد على التعليقات.');
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
