/**
 * Every successful response leaves the API in one shape:
 *
 *   { "ok": true, "data": …, "meta": { "pagination": {…} } }
 *
 * WHY AN ENVELOPE: the Next.js client needs to distinguish "the request worked
 * and returned null" from "the request failed". A bare `null` body cannot carry
 * that distinction, and a bare array cannot carry pagination. One envelope means
 * one fetch helper on the frontend and one OpenAPI schema for all 200s.
 *
 * Services return either a plain value or `{ items, total }`; the interceptor
 * detects the latter and builds the pagination block with the same arithmetic the
 * database pager used, so `totalPages` can never disagree with `total`.
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { toInt } from '@voltade/shared';
import type { Request } from 'express';

type ListResult<T> = { items: T[]; total: number };

function isListResult(value: unknown): value is ListResult<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as ListResult<unknown>).items) &&
    typeof (value as ListResult<unknown>).total === 'number'
  );
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, unknown> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    return next.handle().pipe(
      map((value) => {
        // A controller that already built the envelope (file downloads, sitemaps,
        // webhook acknowledgements) is passed through untouched.
        if (isEnvelope(value)) return value;

        if (isListResult(value)) {
          const page = toInt(request.query.page, 1);
          const perPage = toInt(request.query.perPage ?? request.query.per_page, value.items.length || 24);
          const totalPages = perPage > 0 ? Math.max(1, Math.ceil(value.total / perPage)) : 1;
          return {
            ok: true,
            data: { items: value.items },
            meta: {
              pagination: {
                page,
                perPage,
                total: value.total,
                totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
              },
            },
          };
        }

        return { ok: true, data: value ?? null };
      }),
    );
  }
}

function isEnvelope(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'ok' in (value as Record<string, unknown>);
}
