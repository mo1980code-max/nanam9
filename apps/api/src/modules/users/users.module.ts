import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersAdminController } from './users.admin.controller.js';
import { UsersService } from './users.service.js';

/**
 * Exported because the CMS (author bylines and post ownership), billing (the
 * subscriber on an invoice) and the admin dashboard (top contributors) all resolve
 * the same privacy rules: a banned or deleted account never renders, and the
 * username — not the id — is the public identifier.
 */
@Module({
  controllers: [UsersController, UsersAdminController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
