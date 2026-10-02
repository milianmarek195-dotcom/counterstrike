import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { createServerSchema, updateServerSchema, type CreateServerInput, type UpdateServerInput } from '@celtist/shared';
import { actorFromAuth } from '../audit/audit.service.js';
import { CurrentAuth, Public, RequirePermission, type AuthContext } from '../security/access.js';
import { ServersService } from './servers.service.js';

const idParam = z.uuid();

@Controller('servers')
export class ServersController {
  constructor(private readonly servers: ServersService) {}

  /** Availability only; addresses are shown to players inside their match lobby. */
  @Get()
  @Public()
  async list() {
    return { servers: await this.servers.listPublic() };
  }
}

@Controller('admin/servers')
@RequirePermission('server.view')
export class AdminServersController {
  constructor(private readonly servers: ServersService) {}

  @Get()
  async list() {
    return { servers: await this.servers.listAdmin() };
  }

  @Get(':id')
  get(@Param('id', { schema: idParam }) id: string) {
    return this.servers.get(id);
  }

  /** Returns the API key exactly once. */
  @Post()
  @RequirePermission('server.manage')
  create(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Body({ schema: createServerSchema }) body: CreateServerInput) {
    return this.servers.create(body, actorFromAuth(auth), req.ip);
  }

  @Patch(':id')
  @RequirePermission('server.manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: updateServerSchema }) body: UpdateServerInput,
  ) {
    return this.servers.update(id, body, actorFromAuth(auth), req.ip);
  }

  @Post(':id/rotate-key')
  @RequirePermission('server.keys')
  rotate(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string) {
    return this.servers.rotateKey(id, actorFromAuth(auth), req.ip);
  }

  @Delete(':id')
  @RequirePermission('server.manage')
  @HttpCode(204)
  async remove(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.servers.remove(id, actorFromAuth(auth), req.ip);
  }
}
