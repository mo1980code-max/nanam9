'use client';

/**
 * The game frame — click to play.
 *
 * WHY NOT `<iframe src=...>` STRAIGHT AWAY: an HTML5 game is megabytes of JavaScript,
 * art and audio that the player may never start. Loading it during page render puts it
 * in direct competition with the LCP image and the fonts, which is exactly how a game
 * portal ends up with a 6-second LCP. Here the frame is not even in the document until
 * the player presses play: the page stays light, and the *game* loads on its own
 * budget.
 *
 * `sandbox="allow-scripts allow-same-origin allow-popups allow-forms"` is the minimum a
 * game needs. Note what is missing: no `allow-top-navigation`, so a malicious imported
 * ZIP cannot navigate the whole tab to a phishing page. The frame is also served from
 * our own storage path, not from a third-party origin we do not control.
 */

import { useEffect, useRef, useState } from 'react';

type Props = {
  slug: string;
  title: string;
  src: string;
  poster: string | null;
  width: number | null;
  height: number | null;
  orientation: string | null;
};

export function GamePlayer({ slug, title, src, poster, width, height, orientation }: Props) {
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // A portrait game in a landscape box means huge empty bars; keep the frame's own
  // aspect ratio instead of stretching the art.
  const ratio = width && height ? `${width} / ${height}` : orientation === 'portrait' ? '9 / 16' : '16 / 10';

  const start = () => {
    setStarted(true);
    setLoading(true);
  };

  const toggleFullscreen = () => {
    const node = wrapRef.current;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void node.requestFullscreen?.();
  };

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !started) return;
    const onLoad = () => setLoading(false);
    frame.addEventListener('load', onLoad);
    return () => frame.removeEventListener('load', onLoad);
  }, [started]);

  return (
    <div ref={wrapRef} className="relative w-full overflow-hidden rounded-2xl border border-line bg-black/90">
      <div style={{ aspectRatio: ratio }} className="relative w-full">
        {started ? (
          <iframe
            ref={frameRef}
            key={slug}
            title={`لعبة ${title}`}
            src={src}
            className="absolute inset-0 h-full w-full border-0"
            allow="autoplay; fullscreen; gamepad; xr-spatial-tracking"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-pointer-lock"
          />
        ) : (
          <button
            type="button"
            onClick={start}
            className="group absolute inset-0 flex w-full flex-col items-center justify-center gap-4 bg-cover bg-center text-white"
            style={poster ? { backgroundImage: `linear-gradient(to top, rgba(4,4,12,.86), rgba(4,4,12,.35)), url(${poster})` } : undefined}
            aria-label={`ابدأ لعب ${title}`}
          >
            <span className="grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-brand to-accent text-3xl shadow-2xl transition-transform group-hover:scale-110">
              <span aria-hidden>▶</span>
            </span>
            <span className="rounded-full bg-black/55 px-4 py-1.5 text-sm font-black backdrop-blur">اضغط للعب</span>
          </button>
        )}

        {loading ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1 overflow-hidden">
            <div className="skeleton h-full w-full" />
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line bg-surface px-3 py-2">
        <p className="truncate text-xs text-muted">
          تعمل اللعبة داخل إطار معزول — إن لم تبدأ، تحقّق من مانع الإعلانات أو
          <span className="font-bold"> {orientation === 'portrait' ? 'أدر جهازك عموديًا' : 'أعد تحميل الصفحة'}</span>.
        </p>
        <button type="button" onClick={toggleFullscreen} className="btn btn-ghost !px-3 !py-1.5 text-xs">
          <span aria-hidden>⛶</span> ملء الشاشة
        </button>
      </div>
    </div>
  );
}
