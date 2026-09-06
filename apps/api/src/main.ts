/**
 * API bootstrap.
 *
 * Order matters and each step is here for a reason:
 *   reflect-metadata → decorators and DI types exist at runtime;
 *   loadConfig()     → fail fast on a bad environment, before opening a port;
 *   trust proxy      → without it every client IP is the proxy's, which silently
 *                      collapses all rate limiting into one bucket;
 *   helmet           → security headers on every response, including errors;
 *   compression      → the catalogue is JSON-heavy; gzip cuts payloads ~5×;
 *   cookieParser     → the session lives in cookies;
 *   ValidationPipe   → one place where DTOs are enforced, with the same error
 *                      envelope as everything else;
 *   CORS             → credentials:true, an explicit origin list, and the CSRF
 *                      header allowed (the browser must be able to send it);
 *   shutdown hooks   → SIGTERM drains the pool instead of dropping connections.
 */

import 'reflect-metadata';
import { Logger, ValidationPipe, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { ValidationError } from './common/http/errors.js';
import { StorageService } from './common/storage/storage.service.js';

const LOG_LEVELS: Record<AppConfig['LOG_LEVEL'], LogLevel[]> = {
  error: ['error'],
  warn: ['error', 'warn'],
  log: ['error', 'warn', 'log'],
  debug: ['error', 'warn', 'log', 'debug'],
  verbose: ['error', 'warn', 'log', 'debug', 'verbose'],
};

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger('bootstrap');

  const app = await NestFactory.create(AppModule, { logger: LOG_LEVELS[config.LOG_LEVEL], bufferLogs: false });
  const expressApp = app.getHttpAdapter().getInstance();

  app.setGlobalPrefix(config.API_PREFIX, { exclude: [''] });
  if (config.TRUST_PROXY) expressApp.set('trust proxy', 1);

  const helmetForApi = helmet({
    // A JSON API renders nothing, so the strictest CSP that still allows a browser
    // to show a plain error body.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] } },
    crossOriginEmbedderPolicy: false,
    // Local storage mode serves uploaded artwork from this origin, and the web app
    // is a different origin in development.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  // Swagger UI is a real HTML page: it needs its own inline scripts and styles.
  // Everything else keeps the strict policy, so the exception is one route, not a
  // weakened default.
  const helmetForDocs = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  const docsPath = `/${config.API_PREFIX}/docs`;
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === docsPath || req.path.startsWith(`${docsPath}/`)) helmetForDocs(req, res, next);
    else helmetForApi(req, res, next);
  });
  app.use(compression({ level: 6, threshold: 1024 }));
  app.use(cookieParser());

  // Local storage mode has to serve the bytes it wrote; S3/R2 mode serves them from
  // the CDN and this mount is skipped entirely (one less thing in front of the API).
  const storage = app.get(StorageService);
  if (storage.driver === 'local') {
    app.use(
      config.STORAGE_PUBLIC_BASE,
      express.static(storage.localRoot(), {
        index: false, // never auto-serve index.html for a directory listing
        dotfiles: 'ignore',
        fallthrough: true, // a missing asset should 404 through the normal filter
        maxAge: config.isProduction ? '30d' : 0,
        setHeaders(res, filePath) {
          // Upload keys are content-addressed (sha256), so the bytes at a URL can
          // never change: immutable is safe and removes revalidation traffic.
          res.setHeader('Cache-Control', config.isProduction ? 'public, max-age=2592000, immutable' : 'no-cache');
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          // A uploaded HTML file is a game, not a page of our site: it must not be
          // able to run as a same-origin document with access to our cookies.
          if (/\.html?$/i.test(filePath)) {
            res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:; frame-ancestors *");
            res.setHeader('X-Content-Type-Options', 'nosniff');
          }
        },
      }),
    );
    logger.log(`serving local storage at ${config.STORAGE_PUBLIC_BASE} → ${storage.localRoot()}`);
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown properties: `?sort=` cannot smuggle a field
      transform: true, // "1" → 1 for @Type(() => Number) DTOs
      transformOptions: { enableImplicitConversion: false },
      forbidNonWhitelisted: false, // a stray analytics parameter must not 400 a request
      validationError: { target: false, value: false }, // never echo the payload back
      exceptionFactory: (errors) => {
        const fields: Record<string, string[]> = {};
        for (const error of errors) {
          const messages = Object.values(error.constraints ?? {});
          fields[error.property] = messages.length > 0 ? messages : ['invalid value'];
        }
        return new ValidationError(fields);
      },
    }),
  );

  // The exception filter and the response envelope are registered via APP_FILTER /
  // APP_INTERCEPTOR in CoreModule, so no route can forget them.
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      // Same-origin requests (curl, server-to-server) arrive without an Origin.
      if (!origin) return callback(null, true);
      const allowed = config.corsOrigins.some((o) => o === origin || origin.startsWith(`${o.replace(/\/$/, '')}/`));
      return callback(null, allowed || undefined);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-csrf-token', 'x-request-id', 'accept-language', 'x-play-session'],
    exposedHeaders: ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-request-id'],
    maxAge: 86_400,
  });
  app.enableShutdownHooks();

  registerSwagger(app, config);

  await app.listen(config.API_PORT, config.API_HOST);
  const shown = `http://${config.API_HOST === '0.0.0.0' ? 'localhost' : config.API_HOST}:${config.API_PORT}/${config.API_PREFIX}`;
  logger.log(`API listening on ${shown}`);
  logger.log(`environment: ${config.NODE_ENV} · database: ${redact(config.DATABASE_URL)}`);
  if (!config.hasRedis) logger.warn('REDIS_URL is not set: rate limits, cache and queues are per-process only');
  if (!config.hasSearch) logger.log('search driver: database (PostgreSQL full-text) — set MEILI_HOST for instant search');
}

function registerSwagger(app: { getHttpAdapter(): { getInstance(): unknown }; }, config: AppConfig): void {
  const enabled = !config.isProduction || process.env.SWAGGER_ENABLED === '1';
  if (!enabled) return;

  const builder = new DocumentBuilder()
    .setTitle('Voltade API')
    .setDescription(
      [
        'The REST API behind the Voltade HTML5 games portal.',
        '',
        '**Conventions**',
        '- Every response is `{ ok: true, data, meta? }` or `{ ok: false, error: { code, message, fields? } }`.',
        '- Authentication is a 15-minute access JWT in an httpOnly cookie plus a rotating 30-day refresh token.',
        '- State-changing requests must send the `x-csrf-token` header matching the readable `voltade_csrf` cookie.',
        '- `?page` and `?perPage` page every list; the totals come back in `meta.pagination`.',
        '- Errors carry stable codes (`game.not_found`, `auth.invalid_credentials`) — switch on those, not on messages.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addCookieAuth('voltade_at', { type: 'apiKey', in: 'cookie', name: 'voltade_at' }, 'Access token cookie (set by /auth/login)')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'Bearer token for non-browser clients')
    .addTag('auth', 'Registration, sign-in, sessions, 2FA, OAuth')
    .addTag('games', 'The catalogue: listing, detail, search, play tracking, admin CRUD and uploads')
    .addTag('taxonomy', 'Categories and tags')
    .addTag('social', 'Comments, ratings, likes, favourites, playlists, reports')
    .addTag('users', 'Profiles, XP, achievements, notifications')
    .addTag('cms', 'Pages and the blog')
    .addTag('ads', 'Placements, interstitial scheduling, impression/click tracking')
    .addTag('billing', 'Plans, checkout, subscriptions, webhooks')
    .addTag('admin', 'Dashboard, settings, sections, themes, imports, backups, updates, activity log')
    .addTag('system', 'Health and diagnostics');

  const document = SwaggerModule.createDocument(app as never, builder.build(), {
    operationIdFactory: (_controllerKey: string, methodKey: string) => methodKey,
  });
  SwaggerModule.setup(`${config.API_PREFIX}/docs`, app as never, document, {
    jsonDocumentUrl: `${config.API_PREFIX}/docs/openapi.json`,
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true, tryItOutEnabled: true },
    customSiteTitle: 'Voltade API',
  });
}

function redact(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:••••@');
}

bootstrap().catch((error) => {
  // A boot failure must be loud and must exit non-zero, or an orchestrator will
  // restart a broken process forever without anyone reading the log.
  const logger = new Logger('bootstrap');
  logger.error(error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : undefined);
  process.exit(1);
});
