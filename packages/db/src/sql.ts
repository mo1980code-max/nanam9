/**
 * A tiny SQL template tag.
 *
 * WHY NOT STRING CONCATENATION: every injection bug in a marketplace script
 * starts as `where slug = '${slug}'`. This tag makes parameterisation the path
 * of least resistance — interpolated values always become `$n` placeholders —
 * while still allowing *structural* composition (a WHERE built from optional
 * filters) which is what a catalogue with 12 filters actually needs.
 *
 * Structural pieces are explicit and safe: `sql.ident()` validates the
 * identifier, `sql.raw()` is opt-in and reserved for text this codebase
 * produced (ORDER BY columns from an allowlist, table names from the schema).
 */

export type SqlFragment = {
  readonly __sql: true;
  text: string;
  values: unknown[];
};

export type SqlInput = SqlFragment | string;

const isFragment = (v: unknown): v is SqlFragment =>
  typeof v === 'object' && v !== null && (v as { __sql?: unknown }).__sql === true;

const IDENT_RE = /^[a-z_][a-z0-9_$]*$/i;

/**
 * Shifts every `$n` placeholder in an already-rendered fragment by `offset`.
 *
 * WHY THIS EXISTS: a fragment numbers its own parameters from 1. The moment it is
 * nested inside another fragment its values are appended to the outer list, so
 * its placeholders must be shifted or two different values share `$1` — which
 * Postgres then types from whichever use it resolves first ("operator does not
 * exist: comment_status = text" was this bug, a game id being compared with an
 * enum column). Numbering is therefore a *render-time* concern, applied here and
 * in and()/or(), never left to the caller.
 *
 * Reused numbers (`$1` twice) stay consistent because the shift is per-number.
 */
export function renumber(text: string, offset: number): string {
  if (offset === 0 || !text.includes('$')) return text;
  return text.replace(/\$(\d+)/g, (_m, n: string) => `$${offset + Number(n)}`);
}

export const sql = (strings: TemplateStringsArray, ...parts: unknown[]): SqlFragment => {
  let text = '';
  const values: unknown[] = [];

  const push = (part: unknown): void => {
    if (isFragment(part)) {
      text += renumber(part.text, values.length);
      values.push(...part.values);
      return;
    }
    if (part instanceof RawSql) {
      text += part.text;
      return;
    }
    if (part instanceof Identifier) {
      text += quoteIdentifier(part.name);
      return;
    }
    if (part instanceof PlaceholderList) {
      const start = values.length;
      values.push(...part.items);
      text += part.items.map((_, i) => `$${start + i + 1}`).join(', ');
      return;
    }
    if (part === null || part === undefined) {
      // `where x = ${maybeUndefined}` would silently match nothing; NULL must be
      // written as `IS NULL`, so refuse instead of guessing.
      throw new Error('sql: null/undefined interpolation — use sql.nullable() or an explicit IS NULL branch');
    }
    values.push(part);
    text += `$${values.length}`;
  };

  strings.forEach((chunk, i) => {
    text += chunk;
    if (i < parts.length) push(parts[i]);
  });

  return { __sql: true, text, values };
};

export class RawSql {
  readonly __sql = true as const;
  readonly values: unknown[] = [];
  constructor(public readonly text: string) {}
}

/** Any composable piece of a statement. */
export type SqlPart = SqlFragment | RawSql;

/** Normalises whatever the caller built into `{text, values}` for the driver. */
export function resolvePart(part: SqlPart | string): { text: string; values: unknown[] } {
  if (typeof part === 'string') return { text: part, values: [] };
  return { text: part.text, values: 'values' in part ? part.values : [] };
}
class Identifier {
  constructor(public readonly name: string) {}
}
class PlaceholderList {
  constructor(public readonly items: unknown[]) {}
}

/** Escape hatch for SQL text this codebase generated (never user input). */
sql.raw = (text: string): RawSql => new RawSql(text);

/** Quoted identifier, validated so `sql.ident(req.query.sort)` cannot inject. */
sql.ident = (name: string): Identifier => {
  if (!IDENT_RE.test(name)) throw new Error(`sql.ident: unsafe identifier "${name}"`);
  return new Identifier(name);
};

sql.quote = quoteIdentifier;

/** `IN (${sql.list(ids)})` — an empty list becomes `NULL` so the query stays valid. */
sql.list = (items: unknown[]): PlaceholderList | RawSql =>
  items.length === 0 ? new RawSql('(NULL)') : new PlaceholderList(items);

/** `= ANY(${sql.any(ids)})` — one placeholder, one array param, no re-planning
 *  per list length. An empty list becomes a typed NULL array so the query still
 *  plans and simply matches nothing (Postgres cannot infer the type of `ARRAY[]`). */
sql.any = (items: unknown[]): SqlFragment | RawSql => {
  if (items.length === 0) return new RawSql('NULL::text[]');
  const frag = sql`${items}`;
  return { __sql: true, text: frag.text, values: frag.values };
};

/** Builds a fragment from already-rendered text plus its values. */
sql.fragment = (text: string, values: unknown[] = []): SqlFragment => ({ __sql: true, text, values });

/**
 * Concatenates rendered parts with a joiner, shifting each part's placeholders so
 * the result is one contiguous `$1..$k` sequence over the concatenated values.
 * Both and() and or() go through here — the numbering rule lives in one place.
 */
function join(conds: (SqlPart | null | undefined | false)[], joiner: ' AND ' | ' OR '): { text: string; values: unknown[] } {
  const text: string[] = [];
  const values: unknown[] = [];
  for (const c of conds) {
    if (!c) continue;
    const resolved = resolvePart(c);
    text.push(`(${renumber(resolved.text, values.length)})`);
    values.push(...resolved.values);
  }
  return { text: text.join(joiner), values };
}

/** Joins conditions with OR, dropping the falsy ones (NULL when empty). */
sql.or = (...conds: (SqlPart | null | undefined | false)[]): SqlPart | null => {
  const kept = conds.filter((c): c is SqlPart => Boolean(c));
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!;
  const merged = join(kept, ' OR ');
  return { __sql: true, text: merged.text, values: merged.values };
};

/** Joins conditions with AND, dropping the falsy ones, and returns `TRUE` when
 *  nothing was supplied so `WHERE ${and(conds)}` is always valid SQL. */
sql.and = (...conds: (SqlPart | null | undefined | false)[]): SqlPart => {
  const kept = conds.filter((c): c is SqlPart => Boolean(c));
  if (kept.length === 0) return new RawSql('TRUE');
  if (kept.length === 1) return kept[0]!;
  const merged = join(kept, ' AND ');
  return { __sql: true, text: merged.text, values: merged.values };
};

/** `${sql.maybe(value)}` → placeholder, or the literal NULL when absent. */
sql.maybe = (value: unknown): RawSql | unknown => (value === undefined || value === null ? new RawSql('NULL') : value);

export function quoteIdentifier(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`quoteIdentifier: unsafe identifier "${name}"`);
  return `"${name}"`;
}

/** Flattens nested fragments into `{text, values}` for the driver. */
export function toQuery(input: SqlInput, extraValues: unknown[] = []): { text: string; values: unknown[] } {
  if (typeof input === 'string') return { text: input, values: extraValues };
  return { text: input.text, values: [...input.values, ...extraValues] };
}

/**
 * ORDER BY builder driven by an allowlist: the caller declares which logical
 * sorts exist and what SQL each one is, so a `?sort=` parameter can never reach
 * the query as text.
 */
export function orderBy(allowed: Record<string, string>, requested?: string, fallback?: string): string {
  const key = requested && allowed[requested] ? requested : fallback;
  if (!key || !allowed[key]) return '';
  return `ORDER BY ${allowed[key]}`;
}
