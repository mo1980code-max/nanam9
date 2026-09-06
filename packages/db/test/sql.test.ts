import { describe, expect, it } from 'vitest';
import { sql, resolvePart, renumber, orderBy } from '../src/sql.js';
import { eq, inList, likeAny } from '../src/drivers/pg/helpers.js';

/**
 * The SQL builder is the security boundary of the whole data layer, so its
 * composition rules are tested as units: numbering, nesting, empty inputs,
 * identifier validation. A mistake here is either an injection or a wrong WHERE
 * clause across 200 queries at once.
 */
describe('sql template tag', () => {
  it('parameterises interpolated values in order', () => {
    const q = sql`SELECT * FROM games WHERE slug = ${'snake'} AND plays > ${10}`;
    expect(q.text).toBe('SELECT * FROM games WHERE slug = $1 AND plays > $2');
    expect(q.values).toEqual(['snake', 10]);
  });

  it('refuses null/undefined interpolation instead of silently matching nothing', () => {
    expect(() => sql`WHERE x = ${undefined}`).toThrow(/null\/undefined/);
    expect(() => sql`WHERE x = ${null}`).toThrow(/null\/undefined/);
  });

  it('renumbers a nested fragment so no two values share a placeholder', () => {
    const inner = sql`b = ${2}`;
    const outer = sql`SELECT * FROM t WHERE a = ${1} AND ${inner} AND c = ${3}`;
    expect(outer.text).toBe('SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3');
    expect(outer.values).toEqual([1, 2, 3]);
  });

  it('keeps reused placeholders consistent when shifted', () => {
    const inner = sql`x = $1 OR y = $1`.text; // simulate a hand-written fragment
    const frag = sql.fragment(inner, ['v']);
    const outer = sql`SELECT 1 WHERE z = ${'z'} AND (${frag})`;
    expect(outer.text).toContain('$2');
    expect(outer.values).toEqual(['z', 'v']);
  });
});

describe('sql.and / sql.or', () => {
  it('numbers placeholders contiguously across conditions (regression)', () => {
    // This exact shape produced `c.game_id = $1 AND c.status = $1`, which made
    // Postgres compare a game id with an enum column and fail the whole query.
    const where = resolvePart(sql.and(eq('c.game_id', 'gid'), eq('c.status', 'pending'), sql`c.parent_id IS NULL`));
    expect(where.text).toBe('(c.game_id = $1) AND (c.status = $2) AND (c.parent_id IS NULL)');
    expect(where.values).toEqual(['gid', 'pending']);
  });

  it('drops falsy conditions and stays valid SQL when nothing is left', () => {
    expect(resolvePart(sql.and(null, undefined, false)).text).toBe('TRUE');
    expect(sql.or(null, undefined)).toBeNull();
    const single = sql.and(null, eq('a', 1));
    expect(resolvePart(single).text).toBe('a = $1');
  });

  it('nests: an OR inside an AND shifts the OR block correctly', () => {
    const or = sql.or(eq('title', 'x'), eq('title_en', 'y'))!;
    const where = resolvePart(sql.and(eq('status', 'published'), or, eq('premium', false)));
    expect(where.text).toBe('(status = $1) AND ((title = $2) OR (title_en = $3)) AND (premium = $4)');
    expect(where.values).toEqual(['published', 'x', 'y', false]);
  });

  it('survives three levels of nesting', () => {
    const deep = sql.and(eq('a', 1), sql.or(eq('b', 2), sql.and(eq('c', 3), eq('d', 4))));
    const { text, values } = resolvePart(deep);
    expect(text).toBe('(a = $1) AND ((b = $2) OR ((c = $3) AND (d = $4)))');
    expect(values).toEqual([1, 2, 3, 4]);
  });
});

describe('filter helpers', () => {
  it('eq/inList/likeAny vanish when the input is absent', () => {
    expect(eq('a', undefined)).toBeNull();
    expect(eq('a', null)).toBeNull();
    expect(inList('a', [])).toBeNull();
    expect(inList('a', undefined)).toBeNull();
    expect(likeAny(['a'], '   ')).toBeNull();
  });

  it('inList becomes one ANY(array) placeholder — one plan for every list length', () => {
    const q = resolvePart(inList('status', ['a', 'b', 'c'])!);
    expect(q.text).toBe('status = ANY($1)');
    expect(q.values).toEqual([['a', 'b', 'c']]);
  });

  it('likeAny escapes LIKE wildcards in user input', () => {
    const q = resolvePart(likeAny(['title', 'title_en'], '50%_off')!);
    expect(q.values[0]).toBe('%50\\%\\_off%');
    expect(q.text).toBe('(title ILIKE $1) OR (title_en ILIKE $2)');
    expect(q.values).toEqual(['%50\\%\\_off%', '%50\\%\\_off%']);
  });

  it('sql.any([]) yields a typed NULL array so the query still plans', () => {
    expect(resolvePart(sql.any([])).text).toBe('NULL::text[]');
    expect(resolvePart(sql.any(['a'])).text).toBe('$1');
  });
});

describe('identifier handling', () => {
  it('quotes valid identifiers and rejects anything else', () => {
    expect(sql`${sql.ident('sort_order')}`.text).toBe('"sort_order"');
    expect(() => sql.ident('a; DROP TABLE users')).toThrow(/unsafe identifier/);
    expect(() => sql.ident('1abc')).toThrow(/unsafe identifier/);
    expect(() => sql.raw('x')).not.toThrow(); // raw is the documented escape hatch
  });
});

describe('renumber', () => {
  it('is a no-op at offset 0 and shifts every placeholder otherwise', () => {
    expect(renumber('a = $1 AND b = $2', 0)).toBe('a = $1 AND b = $2');
    expect(renumber('a = $1 AND b = $2', 3)).toBe('a = $4 AND b = $5');
    expect(renumber('no placeholders here', 5)).toBe('no placeholders here');
  });
});

describe('orderBy allowlist', () => {
  const allowed = { newest: 'published_at DESC', popular: 'plays DESC' };

  it('falls back when the requested sort is not on the list', () => {
    expect(orderBy(allowed, 'plays; DROP TABLE games', 'newest')).toBe('ORDER BY published_at DESC');
    expect(orderBy(allowed, 'popular')).toBe('ORDER BY plays DESC');
    expect(orderBy(allowed, undefined, 'newest')).toBe('ORDER BY published_at DESC');
    expect(orderBy(allowed)).toBe('');
  });
});
