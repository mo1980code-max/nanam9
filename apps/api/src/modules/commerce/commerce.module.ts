import { Module } from '@nestjs/common';
import { AdsController } from './ads.admin.controller.js';
import { AdsService } from './ads.service.js';

@Module({
  controllers: [AdsController],
  providers: [AdsService],
  exports: [AdsService],
})
export class CommerceModule {}
