'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker.
 *
 * Registration is deferred until the browser is idle and skipped in development: an
 * aggressive SW in dev would serve yesterday's bundle while Next is recompiling, which
 * is the most confusing bug a portal can ship to its own team.
 */
export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        /* offline support is progressive enhancement; failure is not an error */
      });
    };

    const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (idle) idle(register);
    else window.setTimeout(register, 4000);
  }, []);

  return null;
}
