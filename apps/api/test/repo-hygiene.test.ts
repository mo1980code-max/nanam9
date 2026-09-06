/**
 * No source file may be matched by .gitignore.
 *
 * THIS TEST EXISTS BECAUSE OF A REAL LOSS: the ignore file carried an unanchored
 * `storage/` entry meant for the runtime upload directory. It also matched
 * `apps/api/src/common/storage/`, so the storage service and module were never added
 * to git, never committed, and vanished the moment the workspace was re-created —
 * discovered only when the build could not resolve its own import.
 *
 * The failure is silent by design of git: an ignored file produces no "untracked
 * files" warning, so `git status` looks clean while real code is missing from the
 * repository. A pattern is checked here instead of remembered.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');
const SOURCE_ROOTS = ['apps/api/src', 'apps/web/src', 'packages/db/src', 'packages/shared/src'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.prisma', '.sql', '.css']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(extname(entry))) out.push(full);
  }
  return out;
}

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('repository hygiene', () => {
  const skip = !gitAvailable();

  it.skipIf(skip)('every source file is committable (not matched by .gitignore)', () => {
    const files = SOURCE_ROOTS.filter((root) => existsSync(join(REPO_ROOT, root))).flatMap((root) => walk(join(REPO_ROOT, root)));
    expect(files.length).toBeGreaterThan(50); // a silent empty walk would pass otherwise

    const paths = files.map((file) => relative(REPO_ROOT, file));
    let ignored: string[] = [];
    try {
      // --no-index reports a match even for a file that is already tracked: a pattern
      // that would keep a *new* file out of git is the bug, tracked or not.
      const out = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
        cwd: REPO_ROOT,
        input: `${paths.join('\n')}\n`,
        encoding: 'utf8',
      });
      ignored = out.split('\n').filter(Boolean);
    } catch (error) {
      // git check-ignore exits 1 when nothing is ignored — the outcome we want.
      const err = error as { status?: number; stdout?: string };
      if (err.status !== 1 && err.status !== 0) throw error;
      ignored = (err.stdout ?? '').split('\n').filter(Boolean);
    }

    expect(
      ignored,
      `These source files are matched by .gitignore and would never be committed. ` +
        `Anchor the offending pattern (a leading slash) or negate the path with '!'.`,
    ).toEqual([]);
  });

  it('runtime directories that must stay out of git are still ignored', () => {
    const mustBeIgnored = ['storage/app/games/x/index.html', '.var/db.sqlite', 'apps/api/dist/main.js', 'node_modules/x/index.js', '.env'];
    let ignored: string[] = [];
    try {
      const out = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
        cwd: REPO_ROOT,
        input: `${mustBeIgnored.join('\n')}\n`,
        encoding: 'utf8',
      });
      ignored = out.split('\n').filter(Boolean);
    } catch (error) {
      const err = error as { status?: number; stdout?: string };
      ignored = (err.stdout ?? '').split('\n').filter(Boolean);
    }
    // Anchoring the runtime paths must not have accidentally un-ignored them.
    expect(ignored.sort()).toEqual([...mustBeIgnored].sort());
  });
});
