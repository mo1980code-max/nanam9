import { Global, Module } from '@nestjs/common';
import { AchievementsService } from './achievements.service.js';

/**
 * Global because five feature modules award progress (games, social, playlists,
 * auth streaks, billing) and each would otherwise re-provide the same service.
 */
@Global()
@Module({ providers: [AchievementsService], exports: [AchievementsService] })
export class GamificationModule {}
