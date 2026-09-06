import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { OauthService } from './oauth.service.js';

/**
 * TokenService, JwtModule, the guards and Redis come from the global CoreModule:
 * other modules (users, admin) need them too, and re-declaring them here would
 * create a second instance with its own permission cache.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, OauthService],
  exports: [AuthService, OauthService],
})
export class AuthModule {}
