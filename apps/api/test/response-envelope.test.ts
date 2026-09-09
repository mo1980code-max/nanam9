/**
 * The response envelope is the contract every screen in the frontend is written
 * against, so its edge cases are worth pinning down:
 *
 *  · a list result keeps any EXTRA key it carries (facet counts, a rating
 *    breakdown). Dropping them silently is how an endpoint that looks fine in the
 *    service returns half a payload to the browser — this exact bug hid the star
 *    breakdown of GET /api/ratings behind `{ items: [] }`;
 *  · pagination arithmetic comes from the same numbers the pager used;
 *  · a controller that already built an envelope (sitemap, file download, webhook
 *    acknowledgement) is passed through untouched instead of being wrapped twice.
 */

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Observable, firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { ResponseInterceptor } from '../src/common/http/response.interceptor.js';

function run(value: unknown, query: Record<string, unknown> = {}): Promise<unknown> {
  const interceptor = new ResponseInterceptor<unknown>();
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ query }) }),
  } as unknown as ExecutionContext;
  const next = { handle: () => of(value) } as unknown as CallHandler<unknown>;
  return firstValueFrom(interceptor.intercept(context, next) as Observable<unknown>);
}

type Envelope = { ok: boolean; data: Record<string, unknown>; meta?: { pagination: Record<string, unknown> } };

describe('ResponseInterceptor', () => {
  it('wraps a plain object', async () => {
    const out = (await run({ id: 'x' })) as Envelope;
    expect(out).toEqual({ ok: true, data: { id: 'x' } });
  });

  it('wraps null without inventing a body', async () => {
    const out = (await run(null)) as Envelope;
    expect(out.ok).toBe(true);
    expect(out.data).toBeNull();
  });

  it('keeps extra keys next to items on a list result', async () => {
    const out = (await run({ items: [{ id: 1 }], total: 1, average: 3, breakdown: [{ stars: 3, count: 1 }] })) as Envelope;
    expect(out.data).toEqual({ items: [{ id: 1 }], average: 3, breakdown: [{ stars: 3, count: 1 }] });
    expect(out.meta?.pagination?.total).toBe(1);
  });

  it('computes totalPages, hasNext and hasPrev from the request page size', async () => {
    const out = (await run({ items: Array.from({ length: 10 }, (_, i) => i), total: 95 }, { page: '2', perPage: '10' })) as Envelope;
    const pagination = out.meta?.pagination ?? {};
    expect(pagination).toMatchObject({ page: 2, perPage: 10, total: 95, totalPages: 10, hasNext: true, hasPrev: true });
  });

  it('never reports zero pages for a non-empty total', async () => {
    const out = (await run({ items: [], total: 3 }, { perPage: '24' })) as Envelope;
    expect(out.meta?.pagination?.totalPages).toBe(1);
    expect(out.meta?.pagination?.hasNext).toBe(false);
  });

  it('passes an existing envelope through untouched', async () => {
    const envelope = { ok: true, data: { url: '/sitemap.xml' }, meta: { generated: true } };
    expect(await run(envelope)).toBe(envelope);
  });

  it('falls back to the page size implied by the items when perPage is absent', async () => {
    const out = (await run({ items: [1, 2, 3, 4], total: 8 })) as Envelope;
    expect(out.meta?.pagination).toMatchObject({ perPage: 4, totalPages: 2 });
  });
});
