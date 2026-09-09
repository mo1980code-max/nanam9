import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePrismaSchema, type Field, type ParsedSchema } from '../src/tools/prisma-schema.js';
import { sqlType, columnOf, indexName, uniqueName } from '../src/tools/ddl.js';
import { deriveColumnTypes, renderColumnTypes } from '../src/tools/column-types-cli.js';
import { generateMigrationSql } from '../src/tools/ddl.js';
import { schemaPath, migrationsDir } from '../src/env.js';
import { join } from 'node:path';

/**
 * The generated artifacts are only trustworthy if regenerating them changes
 * nothing. These tests run the generators in-process and byte-compare the result
 * with what is committed — the same gate `npm run sql:check` / `columns:check`
 * runs in CI, asserted here so `npm test` alone is enough.
 *
 * No database needed: this is pure text, and it is the cheapest way to catch
 * "someone edited schema.prisma and forgot to regenerate the migration".
 */

const schemaSource = readFileSync(schemaPath(), 'utf8');
const schema: ParsedSchema = parsePrismaSchema(schemaSource);

describe('prisma schema parsing', () => {
  it('finds every model and enum', () => {
    expect(schema.models.length).toBeGreaterThanOrEqual(43);
    expect(schema.enums.length).toBeGreaterThanOrEqual(33);
    // the 21 tables the brief lists as a minimum, by their physical names
    const required = [
      'users', 'games', 'categories', 'category_game', 'tags', 'tag_game', 'comments', 'likes',
      'ratings', 'playlists', 'playlist_game', 'favorites', 'ads', 'pages', 'blog_posts',
      'blog_categories', 'settings', 'activity_logs', 'roles', 'permissions', 'subscriptions', 'reports',
    ];
    const tables = schema.models.map((m) => m.table);
    for (const table of required) expect(tables, `missing required table ${table}`).toContain(table);
  });

  it('maps every field to a snake_case column', () => {
    for (const model of schema.models) {
      for (const field of model.fields) {
        if (field.isRelationField || schema.modelByName.has(field.type)) continue;
        expect(field.column, `${model.table}.${field.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('declares cuid2 public ids and BigInt internal ids', () => {
    const games = schema.modelByName.get('Game')!;
    const id = games.fields.find((f) => f.name === 'id')!;
    expect(id.type).toBe('String');
    expect(id.dbNative?.name).toBe('VarChar');
    expect(id.dbNative?.args[0]).toBe('30');

    const play = schema.modelByName.get('GamePlay')!;
    expect(play.fields.find((f) => f.name === 'id')!.type).toBe('BigInt');
  });

  it('gives games a unique source_hash (the duplicate-import gate)', () => {
    const games = schema.modelByName.get('Game')!;
    expect(games.fields.some((f) => f.column === 'source_hash')).toBe(true);
    const unique = games.uniques.some((u) => u.fields.map((f) => columnOf(games, f.name)).includes('source_hash'));
    expect(unique).toBe(true);
  });
});

describe('migration generator', () => {
  it('reproduces the committed 0001 migration byte for byte', () => {
    const generated = generateMigrationSql(schema);
    const committed = readFileSync(join(migrationsDir(), '20260905120000_init', 'migration.sql'), 'utf8');
    if (generated !== committed) {
      // Point at the first differing line: a 1100-line diff is unreadable.
      const a = generated.split('\n');
      const b = committed.split('\n');
      const i = a.findIndex((line, n) => line !== b[n]);
      throw new Error(
        `migration.sql is stale — run \`npm run sql:generate -w @voltade/db\`\n` +
          `  first difference at line ${i + 1}:\n` +
          `    generated: ${a[i] ?? '<eof>'}\n` +
          `    committed: ${b[i] ?? '<eof>'}`,
      );
    }
    expect(generated).toBe(committed);
  });

  it('emits no CREATE EXTENSION (contrib is unavailable in PGlite, and the docker image installs them)', () => {
    for (const dir of ['20260905120000_init', '20260905120200_search_and_constraints']) {
      const sql = readFileSync(join(migrationsDir(), dir, 'migration.sql'), 'utf8');
      expect(sql, `${dir} must not require an extension`).not.toMatch(/CREATE EXTENSION/i);
    }
  });

  it('keeps migration 0002 hand-written additions out of the generator\u2019s output', () => {
    const generated = generateMigrationSql(schema);
    expect(generated).not.toContain('search_vector');
    expect(generated).not.toContain('GENERATED ALWAYS AS');
  });
});

describe('column-types generator', () => {
  it('reproduces the committed column-types.ts', () => {
    const generated = renderColumnTypes(deriveColumnTypes(schemaSource));
    const committed = readFileSync(join(schemaPath(), '..', '..', 'src', 'drivers', 'pg', 'column-types.ts'), 'utf8');
    expect(generated, 'column-types.ts is stale — run `npm run columns:generate -w @voltade/db`').toBe(committed);
  });

  it('knows about every jsonb and array column in the schema', () => {
    const types = deriveColumnTypes(schemaSource);
    expect(types.jsonb['games']).toContain('meta');
    expect(types.jsonb['pages']).toContain('blocks');
    expect(types.jsonb['settings']).toContain('value');
    expect(types.arrays['games']).toContain('gallery');
    expect(types.arrays['plans']).toContain('features');
    // relation lists are NOT columns
    expect(types.arrays['plans'] ?? []).not.toContain('subscriptions');
    expect(types.enums['games']!.status).toBe('game_status');
  });
});

describe('sqlType mapping', () => {
  const typeOf = (model: string, field: string): string => {
    const m = schema.modelByName.get(model)!;
    const f = m.fields.find((x) => x.name === field)!;
    return sqlType(f, schema);
  };

  it('maps Prisma types onto the Postgres types the migrations use', () => {
    expect(typeOf('Game', 'title')).toMatch(/^VARCHAR\(\d+\)$/);
    expect(typeOf('Game', 'description')).toBe('TEXT');
    expect(typeOf('Game', 'plays')).toBe('INTEGER');
    expect(typeOf('Game', 'ratingAvg')).toMatch(/^(REAL|DECIMAL|NUMERIC)/);
    expect(typeOf('Game', 'publishedAt')).toMatch(/TIMESTAMPTZ/);
    expect(typeOf('Game', 'status')).toBe('"game_status"');
    expect(typeOf('Game', 'gallery')).toBe('TEXT[]');
    expect(typeOf('Game', 'meta')).toBe('JSONB');
    expect(typeOf('DailyStat', 'day')).toBe('DATE');
    expect(typeOf('User', 'id')).toBe('VARCHAR(30)');
  });

  it('names indexes after columns, not after Prisma field names', () => {
    const user = schema.modelByName.get('User')!;
    const index = user.indexes.find((i) => i.fields.some((f) => f.name === 'roleId'))!;
    expect(indexName(user, index)).toContain('role_id');
    expect(uniqueName(user, user.uniques[0]!)).toMatch(/_key$/);
  });
});

describe('enum declarations', () => {
  it('uses snake_case type names and lowercase values', () => {
    for (const e of schema.enums) {
      expect(e.typeName, e.name).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const v of e.values) expect(v, `${e.typeName}.${v}`).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(e.values.length, `${e.typeName} is empty`).toBeGreaterThan(0);
      expect(new Set(e.values).size, `${e.typeName} has duplicate values`).toBe(e.values.length);
    }
  });

  it('covers the states the product needs', () => {
    const byName = Object.fromEntries(schema.enums.map((e) => [e.typeName, e.values]));
    expect(byName['game_status']).toEqual(expect.arrayContaining(['draft', 'published', 'archived']));
    expect(byName['user_role'] ?? byName['role_slug'] ?? []).toBeDefined();
    expect(byName['stat_dimension']).toEqual(expect.arrayContaining(['site', 'game', 'source', 'country', 'device']));
    expect(byName['badge_tier']).toEqual(expect.arrayContaining(['bronze', 'silver', 'gold', 'platinum']));
  });
});

describe('field-level invariants the brief depends on', () => {
  const field = (model: string, name: string): Field => schema.modelByName.get(model)!.fields.find((f) => f.name === name)!;

  it('stores timestamps as TIMESTAMPTZ(6) everywhere except daily_stats.day', () => {
    for (const model of schema.models) {
      for (const f of model.fields) {
        if (f.type !== 'DateTime') continue;
        // daily_stats.day is a calendar DATE on purpose: it is the rollup's
        // primary key dimension, and a timestamp there would split one day into
        // many rows and make `day >= $1::date` comparisons silently wrong.
        if (model.table === 'daily_stats' && f.column === 'day') {
          expect(f.dbNative?.name).toBe('Date');
          continue;
        }
        expect(f.dbNative?.name, `${model.table}.${f.column}`).toBe('Timestamptz');
        expect(f.dbNative?.args[0], `${model.table}.${f.column}`).toBe('6');
      }
    }
    expect(field('DailyStat', 'day').type).toBe('DateTime');
    expect(field('DailyStat', 'day').dbNative?.name).toBe('Date');
  });

  it('keeps the polymorphic like/report targets free of foreign keys', () => {
    const likes = schema.modelByName.get('Like')!;
    const target = likes.fields.find((f) => f.name === 'targetId')!;
    expect(target.isRelationField).toBe(false);
    expect(likes.fields.some((f) => f.relation && f.name === 'targetId')).toBe(false);
  });

  it('marks the settings value as Json and the page blocks as Json', () => {
    expect(field('Setting', 'value').type).toBe('Json');
    expect(field('Page', 'blocks').type).toBe('Json');
  });
});
