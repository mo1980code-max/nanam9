/**
 * A parser for the subset of `schema.prisma` that Voltade uses.
 *
 * WHY THIS EXISTS
 * ---------------
 * Prisma's own `migrate diff` needs the Rust schema-engine binary, which is
 * downloaded from binaries.prisma.sh at install time. A sandbox (or an air-gapped
 * build machine) that cannot reach that host cannot generate SQL — but it can
 * still *read* a schema file. So the DDL is produced from the same source of
 * truth by this parser instead, and three gates keep it honest:
 *
 *   1. `npm run sql:generate -- --check`   generator output == committed migration
 *   2. `npm run test -w @voltade/db`       the migration actually runs on PostgreSQL
 *   3. schema-parity.test.ts               information_schema of that live database
 *                                          == the models parsed from schema.prisma
 *
 * On a machine with Prisma engines available, `prisma migrate diff` remains the
 * authority and produces the same shapes; this file is what makes the guarantee
 * checkable everywhere else.
 *
 * The parser is deliberately strict about what it accepts: an attribute it does
 * not understand throws, because silently dropping `@db.VarChar(30)` would emit
 * a `text` column and nobody would notice until production.
 */

export type DbNative = {
  /** e.g. VarChar, Timestamptz, SmallInt, Real, Date, Decimal */
  name: string;
  args: string[];
};

export type Relation = {
  name?: string;
  fields: string[];
  references: string[];
  onDelete?: string;
  onUpdate?: string;
};

export type Field = {
  name: string;
  type: string;
  isList: boolean;
  isOptional: boolean;
  isId: boolean;
  isUnique: boolean;
  isUpdatedAt: boolean;
  /** column name after @map, else the Prisma name */
  column: string;
  dbNative?: DbNative;
  /** raw text of @default(...) */
  default?: string;
  relation?: Relation;
  /** true when the field points at another model (no column in the table) */
  isRelationField: boolean;
  line: number;
};

export type IndexField = { name: string; sort?: 'Asc' | 'Desc' };

export type Index = {
  fields: IndexField[];
  unique: boolean;
  explicitName?: string;
  line: number;
};

export type Model = {
  name: string;
  table: string;
  fields: Field[];
  /** single field id, or composite @@id */
  primaryKey?: { fields: string[]; explicitName?: string };
  uniques: Index[];
  indexes: Index[];
  line: number;
};

export type EnumDef = {
  name: string;
  typeName: string;
  values: string[];
  line: number;
};

export type ParsedSchema = {
  enums: EnumDef[];
  models: Model[];
  enumByName: Map<string, EnumDef>;
  modelByName: Map<string, Model>;
};

// ─────────────────────────── low-level scanning ───────────────────────────

/** Splits a line into `head` (name + type) and the list of `@attr(...)` texts. */
function splitAttributes(input: string): { head: string; attrs: string[] } {
  const attrs: string[] = [];
  let head = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '@') {
      // walk to the end of this attribute, respecting (), [], "" and nesting
      let depth = 0;
      let j = i;
      let inString = false;
      for (; j < input.length; j++) {
        const c = input[j]!;
        if (inString) {
          if (c === '\\') j++;
          else if (c === '"') inString = false;
          continue;
        }
        if (c === '"') inString = true;
        else if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (depth === 0 && /\s/.test(c)) break;
      }
      attrs.push(input.slice(i, j));
      i = j;
      continue;
    }
    head += ch;
    i++;
  }
  return { head: head.trim(), attrs };
}

/** `@foo(a, b)` → { name: 'foo', body: 'a, b' } */
function parseAttr(attr: string): { name: string; body: string } {
  const m = /^@@?([A-Za-z_][\w.]*)\s*(?:\(([\s\S]*)\))?$/.exec(attr.trim());
  if (!m) throw new Error(`cannot parse attribute: ${attr}`);
  return { name: m[1]!, body: (m[2] ?? '').trim() };
}

/** Splits top-level comma separated items: `a, b(c, d), "e"` → ['a','b(c, d)','"e"'] */
export function splitArgs(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (inString) {
      cur += c;
      if (c === '\\') {
        cur += body[++i] ?? '';
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((s) => s.length > 0);
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/** `[status, publishedAt(sort: Desc)]` → [{name:'status'},{name:'publishedAt',sort:'Desc'}] */
function parseIndexFields(body: string): IndexField[] {
  const inner = body.trim().replace(/^\[/, '').replace(/\]$/, '');
  return splitArgs(inner).map((part) => {
    const m = /^([\w.]+)\s*\((.*)\)$/.exec(part.trim());
    if (!m) return { name: unquote(part) };
    const opts: IndexField = { name: m[1]! };
    for (const o of splitArgs(m[2]!)) {
      const [k, v] = o.split(':').map((x) => x?.trim());
      if (k === 'sort' && (v === 'Desc' || v === 'Asc')) opts.sort = v;
    }
    return opts;
  });
}

// ──────────────────────────────── the parser ────────────────────────────────

export function parsePrismaSchema(source: string): ParsedSchema {
  const lines = source.split('\n');
  const enums: EnumDef[] = [];
  const models: Model[] = [];

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (!line || line.startsWith('//')) {
      i++;
      continue;
    }

    const enumMatch = /^enum\s+(\w+)\s*\{$/.exec(line);
    const modelMatch = /^model\s+(\w+)\s*\{$/.exec(line);
    const generatorMatch = /^(generator|datasource|type)\s+\w+\s*\{$/.exec(line);

    if (!enumMatch && !modelMatch && !generatorMatch) {
      throw new Error(`schema.prisma:${i + 1}: unexpected top-level line: ${raw}`);
    }

    // collect the block
    const startLine = i + 1;
    const body: string[] = [];
    i++;
    for (; i < lines.length; i++) {
      const l = lines[i] ?? '';
      if (l.trim() === '}') break;
      body.push(l);
    }
    if (i >= lines.length) throw new Error(`schema.prisma:${startLine}: unterminated block`);
    i++;

    if (generatorMatch) continue; // generator/datasource carry no DDL

    if (enumMatch) {
      const def: EnumDef = { name: enumMatch[1]!, typeName: enumMatch[1]!, values: [], line: startLine };
      for (const b of body) {
        const t = b.trim();
        if (!t || t.startsWith('//')) continue;
        if (t.startsWith('@@map')) {
          const { body: args } = parseAttr(t);
          def.typeName = unquote(args);
          continue;
        }
        if (t.startsWith('@')) throw new Error(`schema.prisma: field-level attribute inside enum ${def.name}: ${t}`);
        def.values.push(t.split(/\s+/)[0]!);
      }
      if (def.values.length === 0) throw new Error(`schema.prisma:${startLine}: enum ${def.name} has no values`);
      enums.push(def);
      continue;
    }

    // ── model ──
    const model: Model = {
      name: modelMatch![1]!,
      table: modelMatch![1]!,
      fields: [],
      uniques: [],
      indexes: [],
      line: startLine,
    };

    for (const b of body) {
      const t = b.trim();
      if (!t || t.startsWith('//')) continue;

      if (t.startsWith('@@')) {
        const { name, body: args } = parseAttr(t);
        if (name === 'map') {
          model.table = unquote(args);
        } else if (name === 'id') {
          const named = extractMapName(args);
          model.primaryKey = { fields: parseIndexFields(named.rest).map((f) => f.name), explicitName: named.name };
        } else if (name === 'unique') {
          const named = extractMapName(args);
          model.uniques.push({
            fields: parseIndexFields(named.rest),
            unique: true,
            explicitName: named.name,
            line: startLine,
          });
        } else if (name === 'index') {
          const named = extractMapName(args);
          model.indexes.push({
            fields: parseIndexFields(named.rest),
            unique: false,
            explicitName: named.name,
            line: startLine,
          });
        } else {
          throw new Error(`schema.prisma:${startLine}: unsupported block attribute @@${name} on ${model.name}`);
        }
        continue;
      }

      const { head, attrs } = splitAttributes(t);
      const typeMatch = /^(\w+)\s+([\w.]+)(\[\])?(\?)?$/.exec(head);
      if (!typeMatch) throw new Error(`schema.prisma:${startLine}: cannot parse field line "${t}"`);

      const field: Field = {
        name: typeMatch[1]!,
        type: typeMatch[2]!,
        isList: typeMatch[3] === '[]',
        isOptional: typeMatch[4] === '?',
        isId: false,
        isUnique: false,
        isUpdatedAt: false,
        column: typeMatch[1]!,
        isRelationField: false,
        line: startLine,
      };

      for (const a of attrs) {
        const { name, body: args } = parseAttr(a);
        switch (name) {
          case 'id':
            field.isId = true;
            break;
          case 'unique':
            field.isUnique = true;
            break;
          case 'updatedAt':
            field.isUpdatedAt = true;
            break;
          case 'map':
            field.column = unquote(args);
            break;
          case 'default':
            field.default = args;
            break;
          case 'db': {
            // @db.VarChar(30) arrives as name 'db.VarChar' from parseAttr? no —
            // the attribute text is "@db.VarChar(30)", so name === 'db.VarChar'.
            throw new Error(`schema.prisma:${startLine}: unexpected @db form "${a}"`);
          }
          case 'relation': {
            const rel: Relation = { fields: [], references: [] };
            for (const part of splitArgs(args)) {
              const [k, ...rest] = part.split(':');
              const v = rest.join(':').trim();
              const key = k?.trim();
              if (key === 'fields') rel.fields = parseIndexFields(v).map((f) => f.name);
              else if (key === 'references') rel.references = parseIndexFields(v).map((f) => f.name);
              else if (key === 'onDelete') rel.onDelete = unquote(v);
              else if (key === 'onUpdate') rel.onUpdate = unquote(v);
              else if (key === 'map') {
                /* explicit constraint name — honoured below */
                rel.name = unquote(v);
              }
            }
            field.relation = rel;
            field.isRelationField = rel.fields.length > 0;
            break;
          }
          default: {
            if (name.startsWith('db.')) {
              // parseAttr already separated "@db.VarChar(30)" into name
              // 'db.VarChar' and body '30'; put them back together so the
              // native-type parser below sees the full form.
              const native = args ? `${name.slice(3)}(${args})` : name.slice(3);
              const m = /^(\w+)\s*\((.*)\)$/.exec(native);
              field.dbNative = m
                ? { name: m[1]!, args: splitArgs(m[2]!).map(unquote) }
                : { name: native, args: [] };
              break;
            }
            throw new Error(`schema.prisma:${startLine}: unsupported attribute @${name} on ${model.name}.${field.name}`);
          }
        }
      }

      if (field.isId && model.primaryKey) {
        throw new Error(`schema.prisma:${startLine}: ${model.name} has both @id and @@id`);
      }
      if (field.isId) model.primaryKey = { fields: [field.name] };
      if (field.isUnique && !field.isList) {
        model.uniques.push({ fields: [{ name: field.name }], unique: true, line: startLine });
      }
      model.fields.push(field);
    }

    if (!model.primaryKey) throw new Error(`schema.prisma:${startLine}: model ${model.name} has no primary key`);
    models.push(model);
  }

  return {
    enums,
    models,
    enumByName: new Map(enums.map((e) => [e.name, e])),
    modelByName: new Map(models.map((m) => [m.name, m])),
  };
}

/** `([a, b], map: "x")` → { rest: '[a, b]', name: 'x' } */
function extractMapName(args: string): { rest: string; name?: string } {
  const parts = splitArgs(args);
  let name: string | undefined;
  const rest: string[] = [];
  for (const p of parts) {
    const m = /^map\s*:\s*(.+)$/.exec(p.trim());
    if (m) name = unquote(m[1]!);
    else rest.push(p);
  }
  return { rest: rest.join(', '), name };
}

/**
 * Only the columns a model actually stores.
 *
 * A relation field is identified by its *type* being another model, not by the
 * absence of `@relation(...)`: the back-reference side of a relation
 * (`comments Comment[]`) carries no attribute at all, and treating it as a
 * column would emit a nonsense `comments` text field.
 */
export function scalarFields(model: Model, schema: ParsedSchema): Field[] {
  return model.fields.filter((f) => !schema.modelByName.has(f.type));
}

/** Fields that carry the FK columns of a relation (the owning side). */
export function relationFields(model: Model, schema: ParsedSchema): Field[] {
  return model.fields.filter((f) => schema.modelByName.has(f.type) && f.relation?.fields.length);
}
