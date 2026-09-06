#!/usr/bin/env node
/**
 * Generates `drivers/pg/column-types.ts` from prisma/schema.prisma.
 *
 *   npm run columns:generate          write the file
 *   npm run columns:generate -- --check   fail if the committed file is stale
 *
 * WHY A GENERATED FILE AND NOT RUNTIME INTROSPECTION: the writer needs to know
 * which columns are jsonb *before* it binds a value, and asking the database
 * costs a round trip per process. Deriving it from the schema keeps the answer
 * in the repo, reviewable in a diff, and `--check` makes forgetting to
 * regenerate a CI failure instead of a runtime `invalid input syntax for json`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parsePrismaSchema } from './prisma-schema.js';
import { packageRoot, schemaPath } from '../env.js';
import { join } from 'node:path';

export type ColumnTypes = {
  jsonb: Record<string, string[]>;
  arrays: Record<string, string[]>;
  enums: Record<string, Record<string, string>>;
};

export function deriveColumnTypes(schemaSource: string): ColumnTypes {
  const parsed = parsePrismaSchema(schemaSource);
  const out: ColumnTypes = { jsonb: {}, arrays: {}, enums: {} };

  for (const model of parsed.models) {
    for (const field of model.fields) {
      // A field typed with another model is a relation: no column of its own,
      // even when it is a list (`Subscription[] subscriptions`) and even when it
      // carries no @relation attribute (the back-reference side).
      if (field.isRelationField || parsed.modelByName.has(field.type)) continue;

      if (field.type === 'Json' || field.dbNative?.name === 'Jsonb') {
        (out.jsonb[model.table] ??= []).push(field.column);
      } else if (field.isList) {
        (out.arrays[model.table] ??= []).push(field.column);
      }
      const enumDef = parsed.enumByName.get(field.type);
      if (enumDef) (out.enums[model.table] ??= {})[field.column] = enumDef.typeName;
    }
  }
  for (const bucket of Object.values(out.jsonb)) bucket.sort();
  for (const bucket of Object.values(out.arrays)) bucket.sort();
  return out;
}

const listLiteral = (map: Record<string, string[]>): string =>
  Object.keys(map)
    .sort()
    .map((table) => `  ${JSON.stringify(table)}: ${JSON.stringify(map[table] ?? [])},`)
    .join('\n');

const enumLiteral = (map: Record<string, Record<string, string>>): string =>
  Object.keys(map)
    .sort()
    .map((table) => `  ${JSON.stringify(table)}: ${JSON.stringify(map[table] ?? {})},`)
    .join('\n');

export function renderColumnTypes(types: ColumnTypes): string {
  const counts = {
    jsonb: Object.values(types.jsonb).reduce((n, c) => n + c.length, 0),
    arrays: Object.values(types.arrays).reduce((n, c) => n + c.length, 0),
    enums: Object.values(types.enums).reduce((n, c) => n + Object.keys(c).length, 0),
  };
  return `/**
 * Column types the generic writer cannot infer from a JavaScript value.
 *
 * GENERATED from prisma/schema.prisma — regenerate with \`npm run columns:generate\`
 * in @voltade/db, never edit by hand (\`columns:generate --check\` fails CI on drift).
 * ${counts.jsonb} jsonb · ${counts.arrays} array · ${counts.enums} enum columns.
 *
 * WHY THIS EXISTS: node-postgres serialises a JS array as a Postgres array
 * literal (\`{a,b}\`) and a JS object as \`[object Object]\`. For a \`text[]\` column
 * the first is exactly right; for \`jsonb\` both are wrong, and the failure
 * surfaces as \`invalid input syntax for type json\` on write. Every repository
 * writes through helpers.insert()/update(), so the mapping lives here once and
 * applies to all of them.
 */

/** jsonb columns per table — values are JSON.stringify'd before binding. */
export const JSONB_COLUMNS: Record<string, readonly string[]> = {
${listLiteral(types.jsonb)}
};

/** Scalar array columns per table — bound as JS arrays (pg renders \`{a,b}\`). */
export const ARRAY_COLUMNS: Record<string, readonly string[]> = {
${listLiteral(types.arrays)}
};

/** Enum columns per table → Postgres type name, for explicit \`::type\` casts. */
export const ENUM_COLUMNS: Record<string, Record<string, string>> = {
${enumLiteral(types.enums)}
};

export function isJsonbColumn(table: string, column: string): boolean {
  return (JSONB_COLUMNS[table] ?? []).includes(column);
}

export function enumTypeOf(table: string, column: string): string | undefined {
  return ENUM_COLUMNS[table]?.[column];
}

/** Serialises one value for binding, knowing which column it is going into. */
export function bindValue(table: string, column: string, value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (!isJsonbColumn(table, column)) return value;
  if (typeof value === 'string') {
    // Already JSON (a caller that stringified). Validate instead of
    // double-encoding: JSON.stringify('{}') is '"{}"' — valid JSON, wrong data,
    // and invisible until something reads the row back.
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}
`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const check = argv.includes('--check');
  const target = join(packageRoot(), 'src/drivers/pg/column-types.ts');
  const source = readFileSync(schemaPath(), 'utf8');
  const rendered = renderColumnTypes(deriveColumnTypes(source));

  if (check) {
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      process.stderr.write(`✗ ${target} does not exist — run columns:generate\n`);
      return 1;
    }
    if (current !== rendered) {
      process.stderr.write('✗ column-types.ts is out of date with prisma/schema.prisma\n  run: npm run columns:generate -w @voltade/db\n');
      return 1;
    }
    process.stdout.write('✓ column-types.ts matches schema.prisma\n');
    return 0;
  }

  writeFileSync(target, rendered, 'utf8');
  process.stdout.write(`✓ wrote src/drivers/pg/column-types.ts from schema.prisma\n`);
  return 0;
}

const invoked = process.argv[1];
if (invoked && (invoked.endsWith('column-types-cli.js') || invoked.endsWith('column-types-cli.ts'))) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; },
  );
}
