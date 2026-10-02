import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  GAME_MODES,
  createMapPoolSchema,
  createMapSchema,
  createVetoTemplateSchema,
  updateMapPoolSchema,
  updateMapSchema,
  updateVetoTemplateSchema,
  type CreateMapInput,
  type CreateMapPoolInput,
  type CreateVetoTemplateInput,
  type UpdateMapInput,
} from '@celtist/shared';
import { actorFromAuth } from '../audit/audit.service.js';
import { CurrentAuth, Public, RequirePermission, type AuthContext } from '../security/access.js';
import { MapsService } from './maps.service.js';

const idParam = z.uuid();
const listQuery = z.object({ mode: z.enum(GAME_MODES).optional() });

@Controller()
export class MapsController {
  constructor(private readonly maps: MapsService) {}

  @Get('maps')
  @Public()
  async list(@Query({ schema: listQuery }) query: z.infer<typeof listQuery>) {
    return { maps: await this.maps.listMaps(query.mode) };
  }

  @Get('map-pools')
  @Public()
  async pools() {
    return { pools: await this.maps.listPools() };
  }

  @Get('veto-templates')
  @Public()
  async templates() {
    return { templates: await this.maps.listVetoTemplates() };
  }
}

@Controller('admin/maps')
@RequirePermission('map.manage')
export class AdminMapsController {
  constructor(private readonly maps: MapsService) {}

  @Get()
  async list() {
    return { maps: await this.maps.listMaps(undefined, true) };
  }

  @Post()
  create(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Body({ schema: createMapSchema }) body: CreateMapInput) {
    return this.maps.createMap(body, actorFromAuth(auth), req.ip);
  }

  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: updateMapSchema }) body: UpdateMapInput,
  ) {
    return this.maps.updateMap(id, body, actorFromAuth(auth), req.ip);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.maps.deleteMap(id, actorFromAuth(auth), req.ip);
  }
}

@Controller('admin/map-pools')
@RequirePermission('map.manage')
export class AdminMapPoolsController {
  constructor(private readonly maps: MapsService) {}

  @Post()
  create(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Body({ schema: createMapPoolSchema }) body: CreateMapPoolInput) {
    return this.maps.createPool(body, actorFromAuth(auth), req.ip);
  }

  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: updateMapPoolSchema }) body: Partial<CreateMapPoolInput>,
  ) {
    return this.maps.updatePool(id, body, actorFromAuth(auth), req.ip);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.maps.deletePool(id, actorFromAuth(auth), req.ip);
  }
}

@Controller('admin/veto-templates')
@RequirePermission('map.manage')
export class AdminVetoTemplatesController {
  constructor(private readonly maps: MapsService) {}

  @Post()
  create(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Body({ schema: createVetoTemplateSchema }) body: CreateVetoTemplateInput) {
    return this.maps.createVetoTemplate(body, actorFromAuth(auth), req.ip);
  }

  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: updateVetoTemplateSchema }) body: Partial<CreateVetoTemplateInput>,
  ) {
    return this.maps.updateVetoTemplate(id, body, actorFromAuth(auth), req.ip);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.maps.deleteVetoTemplate(id, actorFromAuth(auth), req.ip);
  }
}
