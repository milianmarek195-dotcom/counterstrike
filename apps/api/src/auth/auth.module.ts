import { Module } from '@nestjs/common';
import { UsersService } from '../users/users.service.js';
import { AuthController } from './auth.controller.js';

@Module({
  controllers: [AuthController],
  providers: [UsersService],
  exports: [UsersService],
})
export class AuthModule {}
