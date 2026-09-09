/**
 * Password hashing — Argon2id, one configuration for the whole product.
 *
 * WHY ARGON2id AND NOT bcrypt: it is memory-hard, so an attacker with a rack of
 * GPUs or ASICs cannot trade silicon for speed the way they can against bcrypt.
 * The parameters below are OWASP's current minimum for an interactive login
 * (19 MiB, t=2, p=1 → ~50 ms on a small VPS): slow enough to make a stuffing
 * attack expensive, fast enough that 20 logins/second on one core is possible.
 *
 * `needsRehash` exists so parameters can be raised later and every login
 * silently upgrades the stored hash — no forced password resets, no migration.
 */

import { hash, verify, type Options } from '@node-rs/argon2';

export const ARGON2_OPTIONS: Options = {
  algorithm: 2, // argon2id
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(stored: string | null | undefined, plain: string): Promise<boolean> {
  if (!stored || !plain) return false;
  try {
    return await verify(stored, plain, ARGON2_OPTIONS);
  } catch {
    // A malformed hash (imported from another system) must fail closed.
    return false;
  }
}

/** True when the stored hash was produced with weaker parameters than today's. */
export function needsRehash(stored: string): boolean {
  const m = /^\$argon2(id|i|d)\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)/.exec(stored);
  if (!m) return true;
  const [, variant, memory, time, parallelism] = m;
  return (
    variant !== 'id' ||
    Number(memory) < ARGON2_OPTIONS.memoryCost! ||
    Number(time) < ARGON2_OPTIONS.timeCost! ||
    Number(parallelism) < ARGON2_OPTIONS.parallelism!
  );
}

/**
 * The seeded admin password must never be a known string. If SEED_ADMIN_PASSWORD
 * is absent the seeder generates one and prints it once — the same stance the
 * legacy installer took with its signing secret ("the sample secret is never
 * installed").
 */
export function seedAdminPassword(): { password: string; generated: boolean } {
  const fromEnv = process.env.SEED_ADMIN_PASSWORD;
  if (fromEnv && fromEnv.length >= 8) return { password: fromEnv, generated: false };
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const password = `Vt-${Array.from(bytes, (b) => alphabet[b % alphabet.length]!).join('')}`;
  return { password, generated: true };
}
