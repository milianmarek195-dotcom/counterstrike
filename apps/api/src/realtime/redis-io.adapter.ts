import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';

/** Shares rooms between several API instances through Redis pub/sub. */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private readonly clients: Redis[] = [];

  connect(redisUrl: string): void {
    const pub = new Redis(redisUrl);
    const sub = pub.duplicate();
    this.clients.push(pub, sub);
    this.adapterConstructor = createAdapter(pub, sub);
  }

  override createIOServer(port: number, options?: Parameters<IoAdapter['createIOServer']>[1]): ReturnType<IoAdapter['createIOServer']> {
    const server = super.createIOServer(port, options);
    // @nestjs/platform-socket.io bundles its own socket.io typings; the runtime objects are compatible.
    if (this.adapterConstructor) server.adapter(this.adapterConstructor as never);
    return server;
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    this.clients.forEach((c) => c.disconnect());
  }
}
