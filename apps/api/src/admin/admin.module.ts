import { Module } from '@nestjs/common';
import { RankingModule } from '../ranking/ranking.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { WebhooksService } from './webhooks.service.js';

@Module({
  imports: [RankingModule],
  controllers: [AdminController],
  providers: [AdminService, WebhooksService],
  exports: [AdminService, WebhooksService],
})
export class AdminModule {}
