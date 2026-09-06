/**
 * Typed configuration, validated once at boot.
 *
 * WHY zod AND NOT `process.env.X ?? 'default'` scattered around: an API with 40
 * environment variables fails in production in the worst possible way — three
 * hours into a traffic spike, because one variable was misspelled and silently
 * fell back to a default. Here every variable is parsed, coerced and validated
 * when the process starts, so a typo is a boot failure with the variable name in
 * the message, not a mystery at runtime.
 *
 * WHY NOT @nestjs/config's schema option: it validates but does not give back a
 * single typed object; `AppConfig` below is what every service injects.
 */

import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

/**
 * `.env` loading, nearest first: `apps/api/.env`, then the repository-root `.env`.
 *
 * `override: false` is the important part — a real environment variable always
 * wins, so a container, a systemd unit or a CI job behaves identically whether or
 * not a file is present, and a stale development file can never shadow production
 * configuration. Without this the CLI tools and the API could disagree about which
 * database they point at, which is the worst kind of bug to debug at 2am.
 */
function injectEnvFiles(): void {
  // dist/config/env.js → apps/api (and src/config/env.ts → apps/api under tsx).
  const apiRoot = resolve(dirname(__filename), '..', '..');
  for (const file of [join(apiRoot, '.env'), resolve(apiRoot, '..', '..', '.env')]) {
    if (existsSync(file)) loadDotenv({ path: file, override: false });
  }
}

injectEnvFiles();

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const optionalUrl = z.string().trim().min(1).optional().or(z.literal('').transform(() => undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  API_PREFIX: z.string().default('api'),
  /** Public origin of THIS API. Media URLs are resolved against it unless a CDN is set. */
  API_PUBLIC_URL: optionalUrl,
  /** Public origin of the Next.js app: CORS, cookie domain, absolute URLs in RSS/sitemaps. */
  APP_URL: z.string().default('http://localhost:3000'),
  /** Comma-separated extra origins allowed by CORS (preview hosts, staging). */
  CORS_ORIGINS: z.string().default(''),

  DATABASE_URL: z.string().default('postgres://postgres:postgres@127.0.0.1:5433/postgres'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DATABASE_MIGRATE_ON_BOOT: booleanish.default(false),

  REDIS_URL: optionalUrl,
  QUEUE_PREFIX: z.string().default('voltade'),

  /** Access-token signing key. Generated per boot in development; mandatory in production. */
  JWT_ACCESS_SECRET: z.string().optional(),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TTL_SECONDS: z.coerce.number().int().min(3600).default(2_592_000),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: booleanish.default(false),
  CSRF_ENABLED: booleanish.default(true),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('storage/app'),
  STORAGE_PUBLIC_BASE: z.string().default('/media'),
  S3_ENDPOINT: optionalUrl,
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_CDN_BASE: optionalUrl,
  S3_FORCE_PATH_STYLE: booleanish.default(true),

  SEARCH_DRIVER: z.enum(['meilisearch', 'database']).default('database'),
  MEILI_HOST: optionalUrl,
  MEILI_API_KEY: z.string().optional(),
  MEILI_INDEX: z.string().default('games'),

  OAUTH_GOOGLE_ID: z.string().optional(),
  OAUTH_GOOGLE_SECRET: z.string().optional(),
  OAUTH_FACEBOOK_ID: z.string().optional(),
  OAUTH_FACEBOOK_SECRET: z.string().optional(),
  OAUTH_DISCORD_ID: z.string().optional(),
  OAUTH_DISCORD_SECRET: z.string().optional(),
  OAUTH_REDIRECT_BASE: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_SUCCESS_URL: optionalUrl,
  STRIPE_CANCEL_URL: optionalUrl,
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_SECRET: z.string().optional(),
  PAYPAL_MODE: z.enum(['sandbox', 'live']).default('sandbox'),

  /** Import cron: off by default so a fresh install never calls a third party. */
  IMPORT_CRON_ENABLED: booleanish.default(false),
  IMPORT_CRON: z.string().default('15 * * * *'),
  ROLLUP_CRON: z.string().default('5 0 * * *'),

  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
  TRUST_PROXY: booleanish.default(true),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  isProduction: boolean;
  /** Public origin of THIS API, without a trailing slash. Media URLs resolve against it. */
  apiPublicUrl: string;
  isTest: boolean;
  corsOrigins: string[];
  /** True when a Redis URL is configured; guards fall back to memory otherwise. */
  hasRedis: boolean;
  hasStorage: boolean;
  hasSearch: boolean;
  oauth: {
    google: { id?: string; secret?: string; enabled: boolean };
    facebook: { id?: string; secret?: string; enabled: boolean };
    discord: { id?: string; secret?: string; enabled: boolean };
  };
};

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  · ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example and fill in the blanks.`);
  }
  const base = parsed.data;

  // A signing secret that is missing in development is generated per boot: the
  // cost is that sessions do not survive a restart, which is exactly what a dev
  // wants. In production it is a hard failure — a well-known default secret is
  // how marketplace scripts get their tokens forged.
  let accessSecret = base.JWT_ACCESS_SECRET;
  if (!accessSecret || accessSecret.length < 16) {
    if (base.NODE_ENV === 'production') {
      throw new Error('JWT_ACCESS_SECRET must be set (>= 16 chars) in production. Generate one with: openssl rand -hex 32');
    }
    accessSecret = randomBytes(32).toString('hex');
  }

  const apiPublicUrl = (base.API_PUBLIC_URL ?? `http://localhost:${base.API_PORT}`).replace(/\/+$/, '');

  const origins = [base.APP_URL, ...base.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)];

  return {
    ...base,
    JWT_ACCESS_SECRET: accessSecret,
    isProduction: base.NODE_ENV === 'production',
    apiPublicUrl,
    isTest: base.NODE_ENV === 'test',
    corsOrigins: [...new Set(origins)],
    hasRedis: Boolean(base.REDIS_URL),
    hasStorage: base.STORAGE_DRIVER === 's3' && Boolean(base.S3_BUCKET && base.S3_ACCESS_KEY_ID && base.S3_SECRET_ACCESS_KEY),
    hasSearch: base.SEARCH_DRIVER === 'meilisearch' && Boolean(base.MEILI_HOST),
    oauth: {
      google: { id: base.OAUTH_GOOGLE_ID, secret: base.OAUTH_GOOGLE_SECRET, enabled: Boolean(base.OAUTH_GOOGLE_ID && base.OAUTH_GOOGLE_SECRET) },
      facebook: { id: base.OAUTH_FACEBOOK_ID, secret: base.OAUTH_FACEBOOK_SECRET, enabled: Boolean(base.OAUTH_FACEBOOK_ID && base.OAUTH_FACEBOOK_SECRET) },
      discord: { id: base.OAUTH_DISCORD_ID, secret: base.OAUTH_DISCORD_SECRET, enabled: Boolean(base.OAUTH_DISCORD_ID && base.OAUTH_DISCORD_SECRET) },
    },
  };
}

/** Process-wide singleton. Nest's ConfigModule registers it; CLI scripts call it directly. */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

export const CONFIG = 'VOLTADE_CONFIG';
