/**
 * Pagination — one implementation, used by the API to clamp input and by the web
 * app to render the pager, so a `?page=0` or `?perPage=10000` cannot mean two
 * different things on the two sides.
 */

import { PAGINATION } from './constants.js';

export type PaginationInput = {
  page?: unknown;
  perPage?: unknown;
  limit?: unknown;
};

export type Pagination = {
  page: number;
  perPage: number;
  offset: number;
};

export function toInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return fallback;
}

export function parsePagination(
  input: PaginationInput = {},
  options: { defaultPerPage?: number; maxPerPage?: number } = {},
): Pagination {
  const defaultPerPage = options.defaultPerPage ?? PAGINATION.defaultPerPage;
  const maxPerPage = options.maxPerPage ?? PAGINATION.maxPerPage;
  const page = Math.max(1, toInt(input.page, 1));
  const raw = input.perPage ?? input.limit;
  const perPage = Math.min(Math.max(1, toInt(raw, defaultPerPage)), maxPerPage);
  return { page, perPage, offset: (page - 1) * perPage };
}

export type PagedResult<T> = {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

export function toPaged<T>(items: T[], total: number, p: Pagination): PagedResult<T> {
  const totalPages = Math.max(1, Math.ceil(total / p.perPage));
  return {
    items,
    page: p.page,
    perPage: p.perPage,
    total,
    totalPages,
    hasNext: p.page < totalPages,
    hasPrev: p.page > 1,
  };
}

/** `1,2,3 … 12,13` window for the pager UI. */
export function pageWindow(current: number, total: number, radius = 2): (number | '…')[] {
  if (total <= radius * 2 + 3) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | '…')[] = [1];
  const from = Math.max(2, current - radius);
  const to = Math.min(total - 1, current + radius);
  if (from > 2) out.push('…');
  for (let i = from; i <= to; i++) out.push(i);
  if (to < total - 1) out.push('…');
  out.push(total);
  return out;
}
