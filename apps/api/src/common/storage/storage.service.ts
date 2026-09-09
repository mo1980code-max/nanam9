/**
 * Object storage: local disk in development, S3-compatible (Cloudflare R2, MinIO,
 * AWS S3) in production, behind one interface.
 *
 * WHY ONE SERVICE AND NOT "just write the file": the URL a game or an artwork ends
 * up with is stored in the database and rendered by the web app forever. If the
 * write path and the URL path disagree — a local `/media/...` relative URL baked
 * into a row, then a move to R2 — every stored URL is wrong and the only fix is a
 * data migration. So the driver decides both the bytes' destination and the public
 * URL, at write time, from configuration.
 *
 * THREE RULES THIS FILE ENFORCES:
 *
 * 1. Keys are validated here, not only by the caller. Upload validation already
 *    rejects `../` inside a ZIP, but storage is the last line before the filesystem:
 *    a key that escapes the root is refused regardless of who built it.
 * 2. Local writes are atomic (temp file + rename). A half-written `index.html`
 *    served to a player is a white screen with a 200 — impossible to debug from the
 *    client side.
 * 3. URLs are absolute. The API and the web app are different origins, so a
 *    relative `/media/x.png` stored in the database would resolve against the wrong
 *    host. In S3 mode the CDN base wins, because that is the whole point of a CDN.
 *
 * There is deliberately no read method: local bytes are served by the express.static
 * mount in main.ts and S3 bytes by the CDN. Reading them back through Node would put
 * the API in front of every image request for no benefit.
 */

import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CONFIG, type AppConfig } from '../../config/env.js';

export type StorageDriver = 'local' | 's3';

export type StoredObject = {
  /** The key it was stored under — what a later `delete()` needs. */
  key: string;
  /** Absolute public URL, ready to store in a row and render. */
  url: string;
  size: number;
  mime: string;
  driver: StorageDriver;
  etag: string | null;
};

/** Keys are content-addressed and never change, so the CDN may cache them forever. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger('storage');
  private readonly root: string;
  private readonly s3: S3Client | null;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    // `hasStorage` is "the s3 driver was asked for AND it is fully configured":
    // asking for S3 with a missing key falls back to local rather than throwing on
    // the first upload, but the boot log says so loudly.
    this.root = isAbsolute(config.STORAGE_LOCAL_DIR)
      ? config.STORAGE_LOCAL_DIR
      : resolve(process.cwd(), config.STORAGE_LOCAL_DIR);

    this.s3 = config.hasStorage
      ? new S3Client({
          region: config.S3_REGION,
          endpoint: config.S3_ENDPOINT || undefined,
          forcePathStyle: config.S3_FORCE_PATH_STYLE,
          credentials: {
            accessKeyId: config.S3_ACCESS_KEY_ID as string,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY as string,
          },
        })
      : null;
  }

  get driver(): StorageDriver {
    return this.s3 ? 's3' : 'local';
  }

  /** Absolute directory the local driver writes to and express.static serves. */
  localRoot(): string {
    return this.root;
  }

  async onModuleInit(): Promise<void> {
    if (this.s3) {
      const via = this.config.S3_ENDPOINT ? `endpoint ${this.config.S3_ENDPOINT}` : 'AWS';
      this.logger.log(`s3 storage: bucket ${this.config.S3_BUCKET} via ${via}${this.config.S3_CDN_BASE ? ` · CDN ${this.config.S3_CDN_BASE}` : ''}`);
      return;
    }
    await mkdir(this.root, { recursive: true });
    this.logger.log(`local storage: ${this.root} served at ${this.config.STORAGE_PUBLIC_BASE}`);
    if (this.config.STORAGE_DRIVER === 's3') {
      // Misconfiguration must be visible at boot, not at the first failed upload.
      this.logger.warn('STORAGE_DRIVER=s3 but S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are incomplete — falling back to local disk');
    }
  }

  /** Store bytes and return the URL that will render them. */
  async put(key: string, data: Buffer, mime = 'application/octet-stream'): Promise<StoredObject> {
    const safe = assertSafeKey(key);

    if (this.s3) {
      const result = await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: safe,
          Body: data,
          ContentType: mime,
          CacheControl: IMMUTABLE,
        }),
      );
      return { key: safe, url: this.publicUrl(safe), size: data.byteLength, mime, driver: 's3', etag: result.ETag ?? null };
    }

    const target = join(this.root, safe);
    await mkdir(dirname(target), { recursive: true });
    // Write beside the target and rename: a reader either sees the old bytes or the
    // complete new ones, never a partial file.
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
    return { key: safe, url: this.publicUrl(safe), size: data.byteLength, mime, driver: 'local', etag: null };
  }

  /** Remove one object. Missing objects are not an error: deletes must be retryable. */
  async delete(key: string): Promise<boolean> {
    const safe = assertSafeKey(key);
    if (this.s3) {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: safe }));
      return true;
    }
    const target = join(this.root, safe);
    if (!existsSync(target)) return false;
    await rm(target, { force: true });
    return true;
  }

  /**
   * The public URL for a key. Pure string work — no I/O — because callers build URLs
   * for objects they have just written and for objects listed from the database.
   */
  publicUrl(key: string): string {
    const safe = assertSafeKey(key);
    if (this.s3) {
      const cdn = this.config.S3_CDN_BASE?.replace(/\/+$/, '');
      if (cdn) return `${cdn}/${safe}`;
      const endpoint = this.config.S3_ENDPOINT?.replace(/\/+$/, '');
      // Path-style matches R2/MinIO; virtual-host style is what plain AWS expects.
      return endpoint
        ? `${endpoint}/${this.config.S3_BUCKET}/${safe}`
        : `https://${this.config.S3_BUCKET}.s3.${this.config.S3_REGION}.amazonaws.com/${safe}`;
    }
    const base = this.config.STORAGE_PUBLIC_BASE.replace(/\/+$/, '');
    // Absolute against the API's own public origin: the web app is a different host,
    // so a root-relative URL would resolve against the wrong one.
    return `${this.config.apiPublicUrl}${base}/${safe}`;
  }
}

/**
 * Refuse any key that could escape the storage root or smuggle a control character.
 *
 * Checked with the resolved path, not with a string pattern alone: `a/../../b` looks
 * harmless to a naive regex on `..` count, and URL-encoded separators have caught out
 * every hand-rolled version of this check that ever shipped.
 */
export function assertSafeKey(key: string, root = ''): string {
  const clean = String(key ?? '').trim().replace(/^\/+/, '');
  if (!clean) throw new Error('storage: empty key');
  if (clean.includes('\0')) throw new Error('storage: key contains a null byte');
  if (clean.includes('\\')) throw new Error(`storage: key contains a backslash (${clean})`);
  if (/[A-Za-z]:/.test(clean)) throw new Error(`storage: key looks like a Windows path (${clean})`);

  // Resolve against the real root when we have one, otherwise against a sentinel:
  // resolving against '/' would make every key look like an escape, because there is
  // nothing above the filesystem root to compare against.
  const base = resolve(root || '/voltade-storage-root');
  const resolved = resolve(base, clean);
  if (resolved !== base && !resolved.startsWith(`${base}/`)) {
    throw new Error(`storage: key escapes the storage root (${clean})`);
  }
  return clean;
}
