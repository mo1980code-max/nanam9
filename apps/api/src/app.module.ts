/**
 * The application module.
 *
 * Wiring rules that make the rest of the codebase boring:
 *  · CoreModule is global: config, database pool, Redis, JWT, guards, the
 *    response envelope and the exception filter. A feature module never
 *    re-declares them, so there is exactly one pool and one guard chain.
 *  · Middleware runs before guards (request id, client IP, play-session cookie,
 *    CSRF cookie), because guards depend on what it sets.
 *  · Feature modules are ordered by dependency, not alphabetically: auth first
 *    (everything else may need it), then the catalogue, then social, admin, cms,
 *    billing, realtime.
 */

import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { AuditModule } from './common/audit/audit.module.js';
import { CoreModule } from './common/core.module.js';
import { StorageModule } from './common/storage/storage.module.js';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware.js';
import { CsrfCookieMiddleware } from './common/auth/csrf.guard.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { GamesModule } from './modules/games/games.module.js';
import { GamificationModule } from './modules/gamification/gamification.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { TaxonomyModule } from './modules/taxonomy/taxonomy.module.js';
import { SocialModule } from './modules/social/social.module.js';

@Module({
  imports: [
    // Infrastructure first: config, pool, Redis, JWT, guards, envelope, exceptions.
    CoreModule,
    StorageModule,
    AuditModule,
    GamificationModule,
    // Feature modules, ordered by dependency: auth (everything may need it), then
    // the catalogue, then the modules that reference games.
    HealthModule,
    AuthModule,
    GamesModule,
    TaxonomyModule,
    SocialModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // '*' covers the global prefix and every route beneath it.
    consumer.apply(RequestContextMiddleware, CsrfCookieMiddleware).forRoutes('*');
  }
}
