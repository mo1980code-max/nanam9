'use client';

/**
 * Instant search: results as you type.
 *
 * WHY A RELATIVE `/api/...` URL AND NOT THE API HOST: this runs in the visitor's
 * browser, where 127.0.0.1 is *their* machine. next.config rewrites `/api/*` to the
 * API, which also keeps the session and CSRF cookies same-origin.
 *
 * WHY HAND-ROLLED DEBOUNCE AND NOT A LIBRARY: 300ms of restraint plus an
 * AbortController is the whole feature. Cancelling the in-flight request matters more
 * than the delay — without it, a fast typist gets results for "sn" arriving after
 * "sna" and the dropdown shows the wrong games.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { mediaUrl, type GameCard } from '@/lib/api';

type Props = {
  variant?: 'bar' | 'page';
  /** Prefills the box (the /search page mirrors the ?q= parameter into it). */
  initialValue?: string;
  autoFocus?: boolean;
};

export function SearchBox({ variant = 'bar', initialValue = '', autoFocus = false }: Props) {
  const router = useRouter();
  const [term, setTerm] = useState(initialValue);
  const [results, setResults] = useState<GameCard[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = term.trim();
    if (query.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch(`/api/games/search?q=${encodeURIComponent(query)}&perPage=6`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        const payload = (await response.json()) as { data?: { items?: GameCard[] } };
        setResults(payload.data?.items ?? []);
        setOpen(true);
      } catch (error) {
        if ((error as Error).name !== 'AbortError') setResults([]);
      } finally {
        setLoading(false);
      }
    }, 260);
    return () => clearTimeout(timer);
  }, [term]);

  // Clicking anywhere else closes the dropdown; Escape closes it and blurs.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const query = term.trim();
    if (!query) return;
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(query)}`);
  };

  const wide = variant === 'page';

  return (
    <div ref={boxRef} className={`relative ${wide ? 'w-full' : 'w-full max-w-md'}`}>
      <form onSubmit={submit} role="search" className="relative">
        <span aria-hidden className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-muted">
          🔎
        </span>
        <input
          autoFocus={autoFocus}
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="ابحث عن لعبة…"
          aria-label="ابحث عن لعبة"
          autoComplete="off"
          className={`w-full rounded-full border border-line bg-surface-2 ps-10 pe-4 text-ink placeholder:text-muted transition-colors focus:border-brand focus:bg-surface ${
            wide ? 'py-3.5 text-base' : 'py-2.5 text-sm'
          }`}
        />
        {loading && (
          <span aria-hidden className="absolute inset-y-0 end-3 flex items-center">
            <span className="skeleton h-4 w-4 rounded-full" />
          </span>
        )}
      </form>

      {open && term.trim().length >= 2 && (
        <div className="absolute z-40 mt-2 w-full overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
          {results.length === 0 ? (
            <p className="px-4 py-5 text-sm text-muted">
              لا نتائج لـ «{term.trim()}». جرّب اسمًا أقصر أو تصفّح <Link className="text-brand" href="/games">كل الألعاب</Link>.
            </p>
          ) : (
            <ul>
              {results.map((game) => (
                <li key={game.id}>
                  <Link
                    href={`/game/${game.slug}`}
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface-2"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={mediaUrl(game.thumbnailUrl) ?? '/brand/og-default.svg'}
                      alt=""
                      width={52}
                      height={40}
                      className="h-10 w-14 rounded-lg object-cover"
                      loading="lazy"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-ink">{game.title}</span>
                      <span className="block truncate text-xs text-muted">
                        {game.categories?.[0]?.name ?? 'ألعاب'} · ▶ {game.plays.toLocaleString('ar-EG')}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link
            href={`/search?q=${encodeURIComponent(term.trim())}`}
            onClick={() => setOpen(false)}
            className="block border-t border-line bg-surface-2 px-4 py-2.5 text-center text-xs font-bold text-brand"
          >
            عرض كل النتائج ←
          </Link>
        </div>
      )}
    </div>
  );
}
