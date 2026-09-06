import { Module } from '@nestjs/common';
import { TaxonomyAdminController } from './taxonomy.admin.controller.js';
import { TaxonomyController } from './taxonomy.controller.js';
import { TaxonomyService } from './taxonomy.service.js';

/**
 * Exported because the CMS (page builders reference categories), the imports module
 * (provider payloads carry category names) and the admin dashboard all resolve
 * taxonomy through the same cycle-safe, slug-based rules.
 */
@Module({
  controllers: [TaxonomyController, TaxonomyAdminController],
  providers: [TaxonomyService],
  exports: [TaxonomyService],
})
export class TaxonomyModule {}
