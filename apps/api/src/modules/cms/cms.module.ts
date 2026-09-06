import { Module } from '@nestjs/common';
import { CmsAdminController } from './cms.admin.controller.js';
import { CmsController } from './cms.controller.js';
import { CmsService } from './cms.service.js';

/**
 * Exported because the sitemap, the RSS feed and the web app's ISR revalidation all
 * need to enumerate live content, and the search indexer needs post bodies. Those are
 * other modules' jobs; re-implementing "what is published right now" in each of them
 * is how a scheduled post ends up in the sitemap but not on the blog.
 */
@Module({
  controllers: [CmsController, CmsAdminController],
  providers: [CmsService],
  exports: [CmsService],
})
export class CmsModule {}
