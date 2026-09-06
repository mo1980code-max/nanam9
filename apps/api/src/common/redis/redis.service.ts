/**
 * Redis, with an in-memory fallback.
 *
 * WHY A FALLBACK: Voltade must boot on a laptop with nothing installed. Rate
 * limiting, the game-page cache and the BullMQ queues all want Redis; when
 * REDIS_URL is absent they degrade to a per-process implementation and log a
 * warning naming exactly what degraded. That is honest — a single-node fallback
 * is not cluster-safe, and the warning says so — and it beats refusing to start.
 *
 * The interface is deliberately tiny (get/set/del/incr/expire) so nothing here
 * leaks ioredis types into services, and swapping Dragonfly/Valkey/keydb later
 * touches one file.
 */

import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { CONFIG, type AppConfig } from '../../config/env.js';
import { Inject } from '@nestjs/common';

type MemoryEntry = { value: string; expiresAt: number };

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger('redis');
  private readonly client: Redis | null = null;
  private readonly memory = new Map<string, MemoryEntry>();
  /** How often the "running without Redis" warning may repeat (ms). */
  private lastWarning = 0;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    if (!config.REDIS_URL) {
      this.logger.warn('REDIS_URL is not set — rate limits, cache and queues fall back to this process only');
      return;
    }
    try {
      this.client = new Redis(config.REDIS_URL, {
        // Namespaced so a shared Redis can be flushed per environment.
        keyPrefix: `${config.QUEUE_PREFIX}:`,
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        lazyConnect: false,
        retryStrategy: (times) => Math.min(times * 200, 5_000),
      });
      this.client.on('error', (error) => {
        this.logger.warn(`redis error: ${error.message} — falling back to in-process storage`);
      });
      this.client.on('connect', () => this.logger.log(`connected (${config.REDIS_URL?.replace(/:[^:@]*@/, ':••••@')})`));
    } catch (error) {
      this.logger.warn(`could not create the redis client: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get enabled(): boolean {
    return this.client !== null && this.client.status === 'ready';
  }

  private warnOnce(what: string): void {
    const now = Date.now();
    if (now - this.lastWarning < 60_000) return;
    this.lastWarning = now;
    this.logger.warn(`${what} is using the in-process fallback (not shared between replicas)`);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.memory) if (entry.expiresAt <= now) this.memory.delete(key);
  }

  async get(key: string): Promise<string | null> {
    if (this.client) {
      try {
        return await this.client.get(key);
      } catch {
        this.warnOnce('cache read');
      }
    }
    this.sweep();
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.client) {
      try {
        if (ttlSeconds) await this.client.set(key, value, 'EX', ttlSeconds);
        else await this.client.set(key, value);
        return;
      } catch {
        this.warnOnce('cache write');
      }
    }
    this.memory.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : Number.MAX_SAFE_INTEGER });
  }

  async del(...keys: string[]): Promise<void> {
    if (this.client) {
      try {
        if (keys.length) await this.client.del(...keys);
        return;
      } catch {
        this.warnOnce('cache delete');
      }
    }
    for (const key of keys) this.memory.delete(key);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      await this.del(key);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  /**
   * Fixed-window counter: returns the count after incrementing, and sets the TTL
   * on the first hit. Two round trips in the worst case, one Lua script in the
   * best — the rate limiter calls this on every request, so it stays cheap.
   */
  async increment(key: string, ttlSeconds: number): Promise<{ count: number; ttlSeconds: number }> {
    if (this.client) {
      try {
        const count = await this.client.incr(key);
        if (count === 1) await this.client.expire(key, ttlSeconds);
        const ttl = await this.client.ttl(key);
        return { count, ttlSeconds: ttl > 0 ? ttl : ttlSeconds };
      } catch {
        this.warnOnce('rate limiting');
      }
    }
    this.sweep();
    const existing = this.memory.get(key);
    const now = Date.now();
    if (!existing || existing.expiresAt <= now) {
      this.memory.set(key, { value: '1', expiresAt: now + ttlSeconds * 1000 });
      return { count: 1, ttlSeconds };
    }
    const count = Number(existing.value) + 1;
    this.memory.set(key, { value: String(count), expiresAt: existing.expiresAt });
    return { count, ttlSeconds: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)) };
  }

  /** Publish/subscribe for the Socket.IO adapter (multi-replica live comments). */
  get raw(): Redis | null {
    return this.client;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => {});
    this.memory.clear();
  }
}
