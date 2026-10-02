import { Module } from '@nestjs/common';
import { AdminMapPoolsController, AdminMapsController, AdminVetoTemplatesController, MapsController } from './maps.controller.js';
import { MapsService } from './maps.service.js';

@Module({
  controllers: [MapsController, AdminMapsController, AdminMapPoolsController, AdminVetoTemplatesController],
  providers: [MapsService],
  exports: [MapsService],
})
export class MapsModule {}
