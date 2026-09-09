import { Module } from '@nestjs/common';
import { SiteAdminController } from './site.admin.controller.js';
import { SiteController } from './site.controller.js';
import { SiteService } from './site.service.js';

/**
 * Exported because settings are read by other modules, not only by the shell:
 * the social module checks `social.commentsEnabled`, the ads module checks
 * `monetisation.adsEnabled`, and the web middleware asks for `maintenance.enabled`.
 * One injected service beats every module re-implementing the cache.
 */
@Module({
  controllers: [SiteController, SiteAdminController],
  providers: [SiteService],
  exports: [SiteService],
})
export class SiteModule {}
