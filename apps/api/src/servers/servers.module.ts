import { Module } from '@nestjs/common';
import { ServerAllocator } from './server-allocator.service.js';
import { ServerHeartbeatService } from './server-heartbeat.service.js';
import { AdminServersController, ServersController } from './servers.controller.js';
import { ServersService } from './servers.service.js';

@Module({
  controllers: [ServersController, AdminServersController],
  providers: [ServersService, ServerAllocator, ServerHeartbeatService],
  exports: [ServersService, ServerAllocator, ServerHeartbeatService],
})
export class ServersModule {}
