/**
 * /api/health — three endpoints with three different jobs:
 *
 *  · GET /api/health/live      → "is the process up?" Never touches a dependency,
 *    so a database outage cannot make the orchestrator restart a healthy API in a
 *    loop (the classic cascade).
 *  · GET /api/health/ready     → "can I serve traffic?" Fails when the database is
 *    unreachable, which is what a load balancer needs to drain a replica.
 *  · GET /api/health           → the diagnostic view: versions, latency, pool state
 *    and which optional services (Redis, search, storage) are degraded.
 */

import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DATABASE, DB_CONNECTION } from '../../common/database/database.module.js';
import { RedisService } from '../../common/redis/redis.service.js';
import { CONFIG, type AppConfig } from '../../config/env.js';
import { Public } from '../../common/decorators/index.js';
import { ServiceUnavailableError } from '../../common/http/errors.js';
import type { Connection, Database } from '@voltade/db';

const startedAt = Date.now();

@ApiTags('system')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(DB_CONNECTION) private readonly conn: Connection,
    private readonly redis: RedisService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness: the process is running' })
  live() {
    return { status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness: the database answers a trivial query' })
  async ready() {
    const started = process.hrtime.bigint();
    try {
      await this.conn.value<number>('SELECT 1');
    } catch (error) {
      throw new ServiceUnavailableError('database', `database is not reachable: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    return { status: 'ready', databaseLatencyMs: Number(process.hrtime.bigint() - started) / 1e6 };
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Diagnostics: versions, latency and degraded optional services' })
  async detail() {
    const started = process.hrtime.bigint();
    let database: { ok: boolean; latencyMs: number; detail?: Record<string, unknown> } = { ok: false, latencyMs: 0 };
    try {
      const health = await this.db.health();
      database = { ok: true, latencyMs: Number(process.hrtime.bigint() - started) / 1e6, detail: health as unknown as Record<string, unknown> };
    } catch (error) {
      database = { ok: false, latencyMs: Number(process.hrtime.bigint() - started) / 1e6, detail: { error: error instanceof Error ? error.message : String(error) } };
    }

    return {
      status: database.ok ? 'ok' : 'degraded',
      version: process.env.npm_package_version ?? '0.1.0',
      environment: this.config.NODE_ENV,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks: {
        database,
        redis: { ok: this.redis.enabled, mode: this.redis.enabled ? 'redis' : 'in-process' },
        search: { ok: this.config.hasSearch, driver: this.config.hasSearch ? 'meilisearch' : 'database' },
        storage: { ok: true, driver: this.config.hasStorage ? 's3' : 'local' },
        queues: { ok: this.config.hasRedis, driver: this.config.hasRedis ? 'bullmq' : 'inline' },
      },
      // Never leak the connection string; a health endpoint is public.
      databaseUrl: redact(this.config.DATABASE_URL),
    };
  }
}

function redact(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:••••@');
}
