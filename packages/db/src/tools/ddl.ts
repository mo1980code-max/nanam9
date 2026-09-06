/**
 * schema.prisma → PostgreSQL DDL.
 *
 * The output follows Prisma's own conventions exactly — quoted identifiers,
 * `{table}_{cols}_key` for uniques, `{table}_{cols}_idx` for indexes,
 * `{table}_{col}_fkey` for foreign keys, `BIGSERIAL` for autoincrement — so a
 * database built from these files is indistinguishable, to `prisma migrate
 * deploy` or `prisma db pull`, from one built by Prisma itself.
 */

import {
  type DbNative,
  type EnumDef,
  type Field,
  type Index,
  type Model,
  type ParsedSchema,
  relationFields,
  scalarFields,
} from './prisma-schema.js';

const MAX_IDENT = 63;

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Postgres silently truncates identifiers; we truncate loudly and deterministically. */
export function ident(name: string): string {
  if (name.length <= MAX_IDENT) return name;
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const suffix = (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
  return `${name.slice(0, MAX_IDENT - 8)}_${suffix}`;
}

// ────────────────────────────── type mapping ──────────────────────────────

export function sqlType(field: Field, schema: ParsedSchema): string {
  const native: DbNative | undefined = field.dbNative;
  const enumDef: EnumDef | undefined = schema.enumByName.get(field.type);

  if (enumDef) {
    if (field.isList) throw new Error(`${field.name}: enum arrays are not supported by the generator`);
    return quoteIdent(enumDef.typeName);
  }

  switch (field.type) {
    case 'String': {
      if (native?.name === 'VarChar') return `VARCHAR(${native.args[0]})`;
      if (native?.name === 'Char') return `CHAR(${native.args[0]})`;
      if (native?.name === 'Text') return 'TEXT';
      if (native?.name === 'Citext') return 'CITEXT';
      if (native) throw new Error(`${field.name}: unsupported @db.${native.name} on String`);
      return field.isList ? 'TEXT[]' : 'TEXT';
    }
    case 'Int': {
      if (native?.name === 'SmallInt') return 'SMALLINT';
      if (native?.name === 'Integer') return 'INTEGER';
      if (native) throw new Error(`${field.name}: unsupported @db.${native.name} on Int`);
      return field.isList ? 'INTEGER[]' : 'INTEGER';
    }
    case 'BigInt': {
      if (native?.name === 'SmallInt') return 'SMALLINT';
      return 'BIGINT';
    }
    case 'Float': {
      if (native?.name === 'Real') return 'REAL';
      if (native?.name === 'Decimal') return `DECIMAL(${native.args.join(',')})`;
      if (native?.name === 'DoublePrecision') return 'DOUBLE PRECISION';
      return 'DOUBLE PRECISION';
    }
    case 'Boolean':
      return 'BOOLEAN';
    case 'DateTime': {
      if (native?.name === 'Date') return 'DATE';
      if (native?.name === 'Timestamptz') return `TIMESTAMPTZ(${native.args[0] ?? '6'})`;
      if (native?.name === 'Timestamp') return `TIMESTAMP(${native.args[0] ?? '3'})`;
      return 'TIMESTAMP(3)';
    }
    case 'Json':
      return 'JSONB';
    case 'Bytes':
      return 'BYTEA';
    default:
      throw new Error(`${field.name}: unknown Prisma type "${field.type}"`);
  }
}

/** Client-side defaults (cuid/uuid/autoincrement) produce no DDL DEFAULT. */
export function sqlDefault(field: Field, schema: ParsedSchema): string | null {
  const d = field.default;
  if (d === undefined) return null;
  if (d === 'autoincrement()' || d === 'cuid()' || d === 'uuid()' || /^cuid\(\d*\)$/.test(d)) return null;
  if (d === 'now()') return 'CURRENT_TIMESTAMP';
  if (d === 'dbgenerated()') return null;
  if (d === 'true' || d === 'false') return d;
  if (/^-?\d+(\.\d+)?$/.test(d)) return d;
  if (d.startsWith('"') && d.endsWith('"')) return quoteLiteral(d.slice(1, -1));
  if (d === '[]') {
    // Postgres needs a cast on an empty array literal.
    const base = sqlType({ ...field, isList: false }, schema);
    return `ARRAY[]::${base}[]`;
  }
  if (d === '{}' || d === '[]') return quoteLiteral(d);
  if (field.type === 'Json') return quoteLiteral(d);
  if (schema.enumByName.has(field.type) && /^[a-z0-9_]+$/i.test(d)) return quoteLiteral(d);
  return quoteLiteral(d);
}

// ─────────────────────────────── naming ───────────────────────────────

/**
 * Prisma writes `@@index([roleId])` with the *field* name, but the index lives on
 * the *column* (`role_id`) — and Prisma names the index after the column too.
 * Emitting the field name would create an index on a column that does not exist.
 */
export function columnOf(model: Model, fieldName: string): string {
  const f = model.fields.find((x) => x.name === fieldName);
  if (!f) throw new Error(`${model.name}: index/relation references unknown field "${fieldName}"`);
  return f.column;
}

/** Prisma's referential-action names → SQL keywords. */
const REFERENTIAL_ACTION: Record<string, string> = {
  Cascade: 'CASCADE',
  Restrict: 'RESTRICT',
  NoAction: 'NO ACTION',
  SetNull: 'SET NULL',
  SetDefault: 'SET DEFAULT',
};

export function referentialAction(action: string): string {
  const mapped = REFERENTIAL_ACTION[action];
  if (!mapped) throw new Error(`unknown referential action "${action}"`);
  return mapped;
}

export function uniqueName(model: Model, index: Index): string {
  if (index.explicitName) return ident(index.explicitName);
  return ident(`${model.table}_${index.fields.map((f) => columnOf(model, f.name)).join('_')}_key`);
}

export function indexName(model: Model, index: Index): string {
  if (index.explicitName) return ident(index.explicitName);
  return ident(`${model.table}_${index.fields.map((f) => columnOf(model, f.name)).join('_')}_idx`);
}

export function fkName(model: Model, field: Field): string {
  if (field.relation?.name) return ident(field.relation.name);
  return ident(`${model.table}_${field.relation!.fields.map((f) => columnOf(model, f)).join('_')}_fkey`);
}

// ─────────────────────────────── emitting ───────────────────────────────

export function emitEnums(schema: ParsedSchema): string[] {
  return schema.enums.map(
    (e) =>
      `-- ${e.name}\nCREATE TYPE ${quoteIdent(e.typeName)} AS ENUM (\n${e.values
        .map((v) => `    ${quoteLiteral(v)}`)
        .join(',\n')}\n);`,
  );
}

export function emitTable(model: Model, schema: ParsedSchema): string {
  const cols = scalarFields(model, schema);
  const lines: string[] = [];

  for (const f of cols) {
    const isSerial = f.default === 'autoincrement()';
    let type = sqlType(f, schema);
    if (isSerial) type = f.type === 'BigInt' ? 'BIGSERIAL' : 'SERIAL';
    const parts = [`${quoteIdent(f.column)}`, type];
    if (!f.isOptional) parts.push('NOT NULL');
    const def = isSerial ? null : sqlDefault(f, schema);
    if (def) parts.push(`DEFAULT ${def}`);
    lines.push(`    ${parts.join(' ')}`);
  }

  const pk = model.primaryKey!;
  lines.push(
    `    CONSTRAINT ${quoteIdent(ident(`${model.table}_pkey`))} PRIMARY KEY (${pk.fields
      .map((f) => quoteIdent(columnOf(model, f)))
      .join(', ')})`,
  );

  return `CREATE TABLE ${quoteIdent(model.table)} (\n${lines.join(',\n')}\n);`;
}

export function emitIndexes(model: Model, _schema: ParsedSchema): string[] {
  const out: string[] = [];
  const cols = (index: Index): string =>
    index.fields.map((f) => `${quoteIdent(columnOf(model, f.name))}${f.sort === 'Desc' ? ' DESC' : ''}`).join(', ');

  for (const u of model.uniques) {
    out.push(`CREATE UNIQUE INDEX ${quoteIdent(uniqueName(model, u))} ON ${quoteIdent(model.table)}(${cols(u)});`);
  }
  for (const ix of model.indexes) {
    out.push(`CREATE INDEX ${quoteIdent(indexName(model, ix))} ON ${quoteIdent(model.table)}(${cols(ix)});`);
  }
  return out;
}

export function emitForeignKeys(model: Model, schema: ParsedSchema): string[] {
  const out: string[] = [];
  for (const f of relationFields(model, schema)) {
    const rel = f.relation!;
    const target = schema.modelByName.get(f.type);
    if (!target) throw new Error(`${model.name}.${f.name}: relation target ${f.type} not found`);
    if (rel.fields.length !== rel.references.length) {
      throw new Error(`${model.name}.${f.name}: relation fields/references arity mismatch`);
    }
    // Prisma defaults: required relation → Restrict, optional → SetNull.
    const onDelete = rel.onDelete ?? (f.isOptional ? 'SetNull' : 'Restrict');
    const onUpdate = rel.onUpdate ?? 'Cascade';
    const targetColumns = rel.references.map((r) => quoteIdent(columnOf(target, r)));
    out.push(
      `ALTER TABLE ${quoteIdent(model.table)} ADD CONSTRAINT ${quoteIdent(fkName(model, f))} FOREIGN KEY (${rel.fields
        .map((c) => quoteIdent(columnOf(model, c)))
        .join(', ')}) REFERENCES ${quoteIdent(target.table)}(${targetColumns.join(', ')}) ON DELETE ${referentialAction(onDelete)} ON UPDATE ${referentialAction(onUpdate)};`,
    );
  }
  return out;
}

export type GenerateOptions = {
  header?: string;
};

/** Full DDL for an empty database → this schema. */
export function generateMigrationSql(schema: ParsedSchema, options: GenerateOptions = {}): string {
  const sections: string[] = [];

  sections.push(
    options.header ??
      [
        '-- ══════════════════════════════════════════════════════════════════════════',
        '-- Voltade — initial schema for PostgreSQL 16',
        '--',
        '-- GENERATED from packages/db/prisma/schema.prisma by @voltade/db (npm run',
        '-- sql:generate). Do not hand-edit: edit the schema and regenerate, then',
        '-- `npm run sql:generate -- --check` proves the two still agree.',
        '-- ══════════════════════════════════════════════════════════════════════════',
      ].join('\n'),
  );

  sections.push('-- ── enums ────────────────────────────────────────────────────────────────');
  sections.push(emitEnums(schema).join('\n\n'));

  sections.push('-- ── tables ───────────────────────────────────────────────────────────────');
  sections.push(schema.models.map((m) => emitTable(m, schema)).join('\n\n'));

  sections.push('-- ── indexes ──────────────────────────────────────────────────────────────');
  sections.push(schema.models.map((m) => emitIndexes(m, schema).join('\n')).filter(Boolean).join('\n'));

  sections.push(
    '-- ── foreign keys (after every table exists, so order cannot matter) ──────',
  );
  sections.push(schema.models.map((m) => emitForeignKeys(m, schema).join('\n')).filter(Boolean).join('\n'));

  return `${sections.filter((s) => s.length > 0).join('\n\n')}\n`;
}
