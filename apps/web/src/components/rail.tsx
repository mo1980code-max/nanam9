'use client';

/**
 * A horizontally scrolling rail with arrow buttons.
 *
 * `scrollBy` on a native scroller instead of a slider library: touch, momentum,
 * keyboard and screen-reader scrolling all keep working, because it *is* a scroll
 * container. Carousel libraries replace that with divs and arrows and then spend
 * their whole bundle re-implementing it worse.
 */

import { useRef, type ReactNode } from 'react';

export function Rail({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);

  const scrollBy = (direction: 1 | -1) => {
    const node = ref.current;
    if (!node) return;
    // In RTL, scrolling "forward" (next items) means a negative delta.
    const rtl = getComputedStyle(node).direction === 'rtl';
    const amount = Math.max(240, node.clientWidth * 0.8);
    node.scrollBy({ left: direction * amount * (rtl ? -1 : 1), behavior: 'smooth' });
  };

  return (
    <div className="relative">
      <div
        ref={ref}
        className="rail no-scrollbar"
        role="list"
        aria-label={label}
        tabIndex={0}
      >
        {children}
      </div>
      <div className="mt-1 flex justify-end gap-2">
        <button type="button" onClick={() => scrollBy(-1)} className="btn btn-ghost !px-3 !py-1.5" aria-label={`السابق في ${label}`}>
          <span aria-hidden>→</span>
        </button>
        <button type="button" onClick={() => scrollBy(1)} className="btn btn-ghost !px-3 !py-1.5" aria-label={`التالي في ${label}`}>
          <span aria-hidden>←</span>
        </button>
      </div>
    </div>
  );
}
