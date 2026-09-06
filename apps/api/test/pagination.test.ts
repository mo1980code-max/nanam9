/**
 * Page-size ceilings, and the class-validator inheritance trap behind them.
 *
 * The admin lists (`/api/admin/redirects`, `/api/admin/activity`, `/api/admin/users`,
 * `/api/admin/reports`) accept `?perPage=100`; the public lists stop at 60. The first
 * implementation of that tried `class AdminPaginationQuery extends PaginationQuery`
 * with a re-declared `perPage` and a wider `@Max`. It compiled, it looked right in
 * Swagger, and it did nothing: class-validator inherits the parent's decorators for
 * the same property, so `@Max(60)` still ran next to `@Max(100)` and the stricter one
 * rejected the request. A 400 on a page size the OpenAPI document advertises as legal.
 *
 * These are runtime validation tests rather than source scans because the bug lives
 * in what the decorators *do*, not in how the file reads.
 */

import { Max, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from 'vitest';
import { AdminPaginationQuery, PaginationQuery } from '../src/common/dto/pagination.dto.js';
import { PAGINATION } from '@voltade/shared';

const errorsOf = async (instance: object): Promise<string[]> => (await validate(instance)).map((error) => error.property);

describe('pagination ceilings', () => {
  it('rejects a public page size above the public ceiling', async () => {
    const query = plainToInstance(PaginationQuery, { perPage: String(PAGINATION.maxPerPage + 1) });
    expect(await errorsOf(query)).toContain('perPage');
  });

  it('accepts the admin ceiling on an admin list', async () => {
    const query = plainToInstance(AdminPaginationQuery, { perPage: String(PAGINATION.adminMaxPerPage) });
    expect(await errorsOf(query)).toHaveLength(0);
    expect(query.perPage).toBe(PAGINATION.adminMaxPerPage);
  });

  it('still rejects an admin page size above the admin ceiling', async () => {
    const query = plainToInstance(AdminPaginationQuery, { perPage: String(PAGINATION.adminMaxPerPage + 1) });
    expect(await errorsOf(query)).toContain('perPage');
  });

  it('coerces the query string and computes the offset', () => {
    const query = plainToInstance(AdminPaginationQuery, { page: '3', perPage: '100' });
    expect(query.page).toBe(3);
    expect(query.perPage).toBe(100);
    expect(query.offset).toBe(200);
    expect(query.pageArg).toEqual({ page: 3, perPage: 100, offset: 200 });
  });

  it('rejects page 0 and a non-numeric page', async () => {
    expect(await errorsOf(plainToInstance(AdminPaginationQuery, { page: '0' }))).toContain('page');
    expect(await errorsOf(plainToInstance(AdminPaginationQuery, { page: 'abc' }))).toContain('page');
  });

  /**
   * The trap, pinned down: re-declaring a property in a subclass does not *add* to the
   * parent's rules for that property, it replaces them. Measured, not assumed — the
   * first version of this test asserted the opposite and failed.
   */
  it('a subclass that re-declares perPage loses the parent validators for it', async () => {
    class OnlyMax extends PaginationQuery {
      @Max(PAGINATION.adminMaxPerPage)
      override perPage = PAGINATION.defaultPerPage;
    }

    // The parent's @Max(60) is gone, so the wider value passes…
    expect(await errorsOf(plainToInstance(OnlyMax, { perPage: '100' }))).toHaveLength(0);

    // …but so is @IsInt. The inherited @Type(() => Number) still runs and turns "abc"
    // into null, which is then reported as a `max` problem on a null — a message no
    // admin UI can turn into "please enter a number".
    const errors = await validate(plainToInstance(OnlyMax, { perPage: 'abc' }));
    const constraints = Object.keys(errors[0]?.constraints ?? {});
    expect(constraints).not.toContain('isInt');

    // The standalone class keeps every rule: "abc" is an integer problem, not a max problem.
    const adminErrors = await validate(plainToInstance(AdminPaginationQuery, { perPage: 'abc' }));
    expect(Object.keys(adminErrors[0]?.constraints ?? {})).toContain('isInt');
  });
});
