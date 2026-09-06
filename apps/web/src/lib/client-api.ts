/**
 * Client-side API helper.
 *
 * Relative URLs only: the browser cannot reach the API's loopback address, so Next's
 * rewrite proxies `/api/*`. That also keeps the session and CSRF cookies same-origin,
 * which is the precondition for the double-submit CSRF defence to work from a browser.
 *
 * The CSRF token is read from the `voltade_csrf` cookie and echoed in a header on every
 * unsafe method. A cross-site form can make the browser *send* the cookie but cannot
 * read it to set the header — that asymmetry is the whole defence.
 */

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export type ApiEnvelope<T> = { ok: boolean; data?: T; error?: { code: string; message: string; fields?: Record<string, string[]> } };

export async function apiFetch<T = unknown>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown } = {},
): Promise<{ status: number; payload: ApiEnvelope<T> }> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  const unsafe = method !== 'GET';
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const token = readCookie('voltade_csrf');
  if (unsafe && token) headers['x-csrf-token'] = token;

  try {
    const response = await fetch(`/api${path.startsWith('/') ? path : `/${path}`}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let payload: ApiEnvelope<T>;
    try {
      payload = text ? (JSON.parse(text) as ApiEnvelope<T>) : { ok: response.ok };
    } catch {
      payload = { ok: false, error: { code: 'unparsable', message: text.slice(0, 160) } };
    }
    return { status: response.status, payload };
  } catch (error) {
    return { status: 0, payload: { ok: false, error: { code: 'network', message: (error as Error).message } } };
  }
}

/** A short, human-readable Arabic message for the error codes the UI actually hits. */
export function errorMessage(status: number, payload: ApiEnvelope<unknown>): string {
  const code = payload.error?.code ?? '';
  if (status === 401) return 'سجّل الدخول أولًا للمتابعة.';
  if (status === 403) return code === 'auth.missing_permission' ? 'ليست لديك صلاحية لهذا الإجراء.' : 'غير مسموح.';
  if (status === 429) return 'طلبات كثيرة — انتظر لحظة ثم أعد المحاولة.';
  if (code === 'validation.failed') {
    const fields = payload.error?.fields ?? {};
    const first = Object.values(fields)[0]?.[0];
    return first ?? 'تحقّق من المدخلات.';
  }
  return payload.error?.message ?? 'تعذّر تنفيذ الطلب.';
}
