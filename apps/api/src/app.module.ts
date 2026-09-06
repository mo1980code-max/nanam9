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
 *    (everything else may need it), then the catalogue, then social, site, users,
 *    cms, realtime. There is deliberately no billing module: payments and paid
 *    subscriptions are out of scope for this product.
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
import { SiteModule } from './modules/site/site.module.js';
import { SocialModule } from './modules/social/social.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { CmsModule } from './modules/cms/cms.module.js';

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
    // Site config comes after the catalogue because sections reference categories and
    // games by slug; users come last because a profile aggregates plays, badges,
    // favourites and playlists from every module above it.
    SiteModule,
    UsersModule,
    // Content comes after users: a post's author is a user, and the blog listing
    // renders that author's display name and avatar.
    CmsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // '*' covers the global prefix and every route beneath it.
    consumer.apply(RequestContextMiddleware, CsrfCookieMiddleware).forRoutes('*');
  }
}
