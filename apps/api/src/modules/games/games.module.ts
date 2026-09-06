import { Module } from '@nestjs/common';
import { GamesAdminController } from './games.admin.controller.js';
import { GamesController } from './games.controller.js';
import { GamesService } from './games.service.js';
import { UploadService } from './upload.service.js';

/**
 * The catalogue module. `GamesService` is exported because the CMS (homepage
 * sections), the social module (comment targets) and the admin dashboard all need
 * to resolve a game by id or slug — and they must resolve it through the same
 * publication rules as the public API, not by querying the table themselves.
 */
@Module({
  controllers: [GamesController, GamesAdminController],
  providers: [GamesService, UploadService],
  exports: [GamesService, UploadService],
})
export class GamesModule {}
