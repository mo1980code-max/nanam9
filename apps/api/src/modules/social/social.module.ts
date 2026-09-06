/**
 * Social module: comments, votes, ratings, favourites, playlists and reports.
 *
 * It imports GamesModule rather than re-querying games, because "is this game
 * playable?" must have exactly one answer in the codebase — a playlist or a comment
 * attached to an archived game is the kind of inconsistency users notice first.
 */

import { Module } from '@nestjs/common';
import { GamificationModule } from '../gamification/gamification.module.js';
import { GamesModule } from '../games/games.module.js';
import { SocialAdminController } from './social.admin.controller.js';
import { SocialController } from './social.controller.js';
import { SocialService } from './social.service.js';

@Module({
  imports: [GamesModule, GamificationModule],
  controllers: [SocialController, SocialAdminController],
  providers: [SocialService],
  exports: [SocialService],
})
export class SocialModule {}
