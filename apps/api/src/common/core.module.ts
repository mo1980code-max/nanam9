/**
 * CoreModule: the wiring every request passes through.
 *
 * Guard order matters and is deliberate — cheapest and most protective first:
 *   1. RateLimitGuard  → an attacker's 10 000 rps never reaches a DB query;
 *   2. AuthGuard       → resolves who is calling (or that nobody is);
 *   3. PermissionsGuard→ decides whether they may;
 *   4. CsrfGuard       → proves the browser request came from our own page.
 *
 * The response envelope, the exception filter and the Redis client are global for
 * the same reason the guards are: consistency is only real if it cannot be opted
 * out of by forgetting an import.
 */

import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { CONFIG, getConfig, type AppConfig } from '../config/env.js';
import { RedisService } from './redis/redis.service.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { PermissionsGuard } from './auth/permissions.guard.js';
import { RateLimitGuard } from './auth/rate-limit.guard.js';
import { CsrfGuard } from './auth/csrf.guard.js';
import { ResponseInterceptor } from './http/response.interceptor.js';
import { AllExceptionsFilter } from './http/all-exceptions.filter.js';
import { TokenService } from '../modules/auth/token.service.js';

@Global()
@Module({
  imports: [
    DatabaseModule.forRoot(),
    JwtModule.registerAsync({
      global: true,
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.JWT_ACCESS_SECRET,
        signOptions: {
          algorithm: 'HS256',
          expiresIn: config.JWT_ACCESS_TTL_SECONDS,
          // The API is the only issuer, so the audience/issuer claims make a token
          // from another service on the same domain unusable here.
          issuer: 'voltade-api',
          audience: 'voltade-web',
        },
      }),
    }),
  ],
  providers: [
    { provide: CONFIG, useFactory: () => getConfig() },
    RedisService,
    TokenService,
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [CONFIG, RedisService, TokenService, JwtModule],
})
export class CoreModule {}
