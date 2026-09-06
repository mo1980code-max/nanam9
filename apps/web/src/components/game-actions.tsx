'use client';

/**
 * Everything a player can *do* beside the game: play tracking, like/dislike, star
 * rating, favourite and share. The frame itself lives in GamePlayer.
 *
 * WHY PLAY IS REPORTED ON MOUNT AND NOT ON CLICK: the iframe owns the click. We never
 * see it, so the only reliable signal that a game started is that the player rendered
 * it. The counter is also what awards XP and unlocks achievements server-side, so
 * missing it would silently break the gamification layer.
 *
 * OPTIMISTIC UI WITH ROLLBACK: the button updates instantly and reverts on failure.
 * A 300ms round-trip on a "like" feels broken; a lie that gets corrected 1% of the
 * time feels fine, and the server's number is always the one that ends up on screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/client-api';
import type { GamePage } from '@/lib/api';

type Props = { game: GamePage['game']; viewer: GamePage['viewer'] };

const nf = new Intl.NumberFormat('ar-EG');

export function GameActions({ game, viewer }: Props) {
  const [vote, setVote] = useState<'like' | 'dislike' | null>(viewer.vote ?? null);
  const [likes, setLikes] = useState(game.likesCount);
  const [dislikes, setDislikes] = useState(game.dislikesCount);
  const [favorite, setFavorite] = useState(viewer.favorite);
  const [rating, setRating] = useState<number | null>(viewer.rating);
  const [review, setReview] = useState(viewer.review ?? '');
  const [hoverStars, setHoverStars] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const playedRef = useRef(false);

  const say = (text: string | null) => {
    setMessage(text);
    if (text) window.setTimeout(() => setMessage(null), 4000);
  };

  // Report the play once per page load. `navigator.sendBeacon` would survive a
  // navigation away, but the request has to carry cookies and a CSRF header, which a
  // beacon cannot do — so a normal fetch on mount it is.
  useEffect(() => {
    if (playedRef.current) return;
    playedRef.current = true;
    const device = /tablet|ipad/i.test(navigator.userAgent) ? 'tablet' : /mobi|phone/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
    void apiFetch('/games/play', { method: 'POST', body: { game: game.slug, device } });
  }, [game.slug]);

  const sendVote = useCallback(
    async (value: 1 | -1) => {
      const next = value === 1 ? 'like' : 'dislike';
      const previous = vote;
      const previousLikes = likes;
      const previousDislikes = dislikes;
      // Toggling the same button again clears the vote (value 0).
      const clearing = previous === next;
      setVote(clearing ? null : next);
      setLikes(previousLikes + (clearing ? (previous === 'like' ? -1 : 0) : value === 1 ? 1 : previous === 'like' ? -1 : 0));
      setDislikes(previousDislikes + (clearing ? (previous === 'dislike' ? -1 : 0) : value === -1 ? 1 : previous === 'dislike' ? -1 : 0));

      const { status, payload } = await apiFetch('/votes', {
        method: 'POST',
        body: { target: 'game', targetId: game.id, value: clearing ? 0 : value },
      });
      if (!payload.ok) {
        setVote(previous);
        setLikes(previousLikes);
        setDislikes(previousDislikes);
        say(errorMessage(status, payload));
        return;
      }
      const data = payload.data as { likesCount?: number; dislikesCount?: number; vote?: string | null } | undefined;
      if (data && typeof data.likesCount === 'number') setLikes(data.likesCount);
      if (data && typeof data.dislikesCount === 'number') setDislikes(data.dislikesCount);
    },
    [dislikes, game.id, likes, vote],
  );

  const toggleFavorite = async () => {
    const previous = favorite;
    setFavorite(!previous);
    const { status, payload } = await apiFetch('/favorites', { method: 'POST', body: { game: game.slug } });
    if (!payload.ok) {
      setFavorite(previous);
      say(errorMessage(status, payload));
      return;
    }
    const data = payload.data as { favorite?: boolean } | undefined;
    if (data && typeof data.favorite === 'boolean') setFavorite(data.favorite);
    say(!previous ? 'أُضيفت إلى المفضلة ⭐' : 'أُزيلت من المفضلة');
  };

  const submitRating = async (stars: number) => {
    setBusy(true);
    const { status, payload } = await apiFetch('/ratings', {
      method: 'POST',
      body: { game: game.slug, stars, review: review.trim() || undefined },
    });
    setBusy(false);
    if (!payload.ok) {
      say(errorMessage(status, payload));
      return;
    }
    setRating(stars);
    say('شكرًا لتقييمك!');
  };

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: game.title, text: game.description ?? undefined, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      say('نُسخ الرابط 📋');
    } catch {
      say('تعذّرت المشاركة من هذا المتصفح.');
    }
  };

  const stars = rating ?? 0;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void sendVote(1)} className={`btn ${vote === 'like' ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={vote === 'like'}>
          <span aria-hidden>👍</span> {nf.format(likes)}
        </button>
        <button type="button" onClick={() => void sendVote(-1)} className={`btn ${vote === 'dislike' ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={vote === 'dislike'}>
          <span aria-hidden>👎</span> {nf.format(dislikes)}
        </button>
        <button type="button" onClick={() => void toggleFavorite()} className={`btn ${favorite ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={favorite}>
          <span aria-hidden>{favorite ? '⭐' : '☆'}</span> {favorite ? 'في المفضلة' : 'أضف للمفضلة'}
        </button>
        <button type="button" onClick={() => void share()} className="btn btn-ghost">
          <span aria-hidden>🔗</span> مشاركة
        </button>
      </div>

      {message ? (
        <p role="status" className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm font-bold text-ink">
          {message}
        </p>
      ) : null}

      <div className="card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-black text-ink">تقييمك</h2>
          <span className="text-xs text-muted">
            {game.ratingCount > 0 ? `${nf.format(game.ratingCount)} تقييم · متوسط ${game.ratingAvg?.toFixed(1) ?? '—'} من ٥` : 'كن أول من يقيّم'}
          </span>
        </div>
        <div className="mb-3 flex items-center gap-1" role="radiogroup" aria-label="التقييم بالنجوم">
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={stars === value}
              aria-label={`${value} من ٥`}
              onMouseEnter={() => setHoverStars(value)}
              onMouseLeave={() => setHoverStars(0)}
              onClick={() => void submitRating(value)}
              disabled={busy}
              className={`text-2xl transition-transform hover:scale-110 ${value <= (hoverStars || stars) ? 'text-star' : 'text-line-strong'}`}
            >
              ★
            </button>
          ))}
          {stars > 0 ? <span className="ms-2 text-xs font-bold text-muted">تقييمك: {stars} / ٥</span> : null}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={review}
            onChange={(event) => setReview(event.target.value.slice(0, 500))}
            placeholder="اكتب مراجعة قصيرة (اختياري)"
            className="flex-1 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-brand focus:bg-surface"
          />
          <button type="button" onClick={() => void submitRating(Math.max(1, stars))} disabled={busy || stars === 0} className="btn btn-primary">
            {busy ? '…' : 'حفظ التقييم'}
          </button>
        </div>
      </div>

    </div>
  );
}
