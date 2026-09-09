/**
 * Structural tests for things TypeScript cannot see.
 *
 * Both failures encoded here happened for real and both returned HTTP 200 while
 * doing nothing — the worst kind of bug, because the client believes it worked:
 *
 *  1. A DTO imported with `import type` is erased. TypeScript then emits
 *     `design:paramtypes = Function` for that parameter, Nest's ValidationPipe
 *     validates a bare `Function` (no decorators → nothing to check) and
 *     `plainToInstance(Function, body)` drops every field. `POST /admin/comments/:id/moderate`
 *     accepted `{status:"visible"}` and changed nothing.
 *  2. Global guards run in registration order. With RateLimit before Auth, the
 *     limiter always saw `req.user === undefined` and keyed every bucket by IP, so
 *     every player behind one NAT shared a single 10-comments-per-5-minutes budget.
 *
 * These are source-level scans rather than runtime reflection on purpose: vitest
 * transforms with esbuild, which does not emit decorator metadata, so a test that
 * inspected `design:paramtypes` here would be measuring nothing.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const controllers = files.filter((file) => file.endsWith('.controller.ts'));

/** Every identifier brought in as a *value* by a file's import statements. */
function valueImports(source: string): Set<string> {
  const names = new Set<string>();
  const re = /import\s+(type\s+)?\{([^}]*)\}\s+from/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const wholeImportIsType = Boolean(match[1]);
    // `noUncheckedIndexedAccess`: a capture group is `string | undefined` even when the
    // pattern guarantees it, so fall back to '' rather than asserting.
    for (const raw of (match[2] ?? '').split(',')) {
      const spec = raw.trim();
      if (!spec) continue;
      // `import { type Foo }` erases Foo exactly like `import type { Foo }`.
      if (wholeImportIsType || spec.startsWith('type ')) continue;
      const local = spec.split(/\s+as\s+/).pop()!.trim();
      if (local) names.add(local);
    }
  }
  return names;
}

describe('controller wiring', () => {
  it('has controllers to check', () => {
    expect(controllers.length).toBeGreaterThan(5);
  });

  it('never imports a DTO type-only in a controller', () => {
    const offenders: string[] = [];
    for (const file of controllers) {
      const source = readFileSync(file, 'utf8');
      // `import type { FooDto }` …
      const typeOnly = /import\s+type\s+\{([^}]*)\}\s+from/g;
      let match: RegExpExecArray | null;
      while ((match = typeOnly.exec(source))) {
        for (const name of (match[1] ?? '').split(',')) {
          const local = name.split(/\s+as\s+/).pop()!.trim();
          if (/Dto$/.test(local)) offenders.push(`${relative(SRC, file)}: import type { ${local} }`);
        }
      }
      // … and `import { type FooDto }`, which erases the same way.
      const inline = /import\s+\{([^}]*)\}\s+from/g;
      while ((match = inline.exec(source))) {
        for (const spec of (match[1] ?? '').split(',')) {
          const trimmed = spec.trim();
          if (!trimmed.startsWith('type ')) continue;
          const local = trimmed.slice(5).split(/\s+as\s+/).pop()!.trim();
          if (/Dto$/.test(local)) offenders.push(`${relative(SRC, file)}: import { type ${local} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares every @Body()/@Query() DTO it uses as a value import', () => {
    const missing: string[] = [];
    for (const file of controllers) {
      const source = readFileSync(file, 'utf8');
      // A DTO may also be declared in the controller file itself; what matters is
      // that the identifier exists at runtime, not where it came from.
      const values = valueImports(source);
      for (const declared of source.matchAll(/(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g)) {
        const name = declared[1];
        if (name) values.add(name);
      }
      // Parameter annotations that follow a body/query decorator.
      const re = /@(?:Body|Query)\([^)]*\)\s*(?:@[A-Za-z]+\([^)]*\)\s*)*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source))) {
        const type = match[2] ?? '';
        if (!/Dto$/.test(type)) continue;
        if (!values.has(type)) missing.push(`${relative(SRC, file)}: ${match[1]}: ${type}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('global guard order', () => {
  it('identifies the caller before metering them', () => {
    const source = readFileSync(join(SRC, 'common', 'core.module.ts'), 'utf8');
    const order = [...source.matchAll(/APP_GUARD,\s*useClass:\s*(\w+)/g)].map((m) => m[1]);

    expect(order).toContain('AuthGuard');
    expect(order).toContain('RateLimitGuard');
    // The rate limiter reads req.user for its bucket key, so it must run second.
    expect(order.indexOf('AuthGuard')).toBeLessThan(order.indexOf('RateLimitGuard'));
    // Permissions need the resolved role.
    expect(order.indexOf('AuthGuard')).toBeLessThan(order.indexOf('PermissionsGuard'));
    // CSRF is the cheapest rejection and must not wait on a session lookup.
    expect(order.indexOf('CsrfGuard')).toBeLessThan(order.indexOf('AuthGuard'));
  });
});
