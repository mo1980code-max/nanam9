/**
 * Uploads: game archives and artwork.
 *
 * THE RULE: nothing is stored until it has been proven safe. A ZIP is unpacked in
 * memory, every entry path is normalised, the total inflated size is bounded, the
 * entry point must exist, and the HTML is audited. Only then does a single byte
 * reach storage. This is the difference between "we accept ZIPs" and "we accept
 * ZIPs and still sleep at night".
 *
 * DEDUPLICATION: the archive's fingerprint is sha256(index.html + sorted entry
 * list). Two publishers uploading the same build — or the same build arriving from
 * GameMonetize and from a manual upload — produce the same hash, and the second
 * upload is refused with a pointer to the existing game instead of creating a
 * duplicate that pollutes search and analytics. The same column
 * (`games.source_hash`) also deduplicates provider imports.
 *
 * SVG: artwork uploads accept PNG/JPEG/WebP/GIF/AVIF only. SVG is a scripting
 * language with a file extension, and a stored SVG that runs JS in our origin is
 * a session-theft primitive — so it is rejected at the door rather than sanitised
 * with a regex.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Database } from '@voltade/db';
import { DATABASE } from '../../common/database/database.module.js';
import { AppError } from '../../common/http/errors.js';
import { StorageService, type StoredObject } from '../../common/storage/storage.service.js';
import { auditHtml, findEntryPoint, readZip } from './zip.js';

const IMAGE_MAGIC: Record<string, { bytes: number[]; ext: string; mime: string }> = {
  png: { bytes: [0x89, 0x50, 0x4e, 0x47], ext: 'png', mime: 'image/png' },
  jpeg: { bytes: [0xff, 0xd8, 0xff], ext: 'jpg', mime: 'image/jpeg' },
  gif: { bytes: [0x47, 0x49, 0x46, 0x38], ext: 'gif', mime: 'image/gif' },
  webp: { bytes: [0x52, 0x49, 0x46, 0x46], ext: 'webp', mime: 'image/webp' },
  avif: { bytes: [0x00, 0x00, 0x00], ext: 'avif', mime: 'image/avif' }, // ftyp check below
};

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export type ArchiveManifest = {
  key: string;
  sourceHash: string;
  entryPointUrl: string;
  entryPointPath: string;
  /** Title derived from the archive name; the editor can change it before publishing. */
  title: string;
  files: number;
  totalBytes: number;
  sizeKb: number;
  warnings: string[];
  duplicateOf: { id: string; slug: string; title: string } | null;
  /** Best-effort canvas size read from the entry HTML (absent on a duplicate hit). */
  dimensions?: { width: number | null; height: number | null };
};

@Injectable()
export class UploadService {
  private readonly logger = new Logger('upload');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly storage: StorageService,
  ) {}

  /**
   * Validate + store a game archive. It deliberately does NOT create a game row:
   * slug generation, uniqueness and taxonomy wiring belong to GamesService, and an
   * upload that half-created a draft would leave orphan rows behind on failure.
   */
  async storeArchive(input: { buffer: Buffer; originalName: string }): Promise<ArchiveManifest> {
    const { buffer, originalName } = input;
    if (!buffer || buffer.byteLength === 0) throw new AppError('upload.empty', 'the uploaded file is empty', 400);
    if (!/\.zip$/i.test(originalName)) {
      throw new AppError('upload.wrong_type', 'game uploads must be a .zip archive', 415);
    }

    const archive = readZip(buffer);
    const entry = findEntryPoint(archive.entries);
    const html = archive.entries.find((e) => e.path === entry.path)!.data.toString('utf8');
    const audit = auditHtml(html);
    if (audit.blocked.length > 0) {
      throw new AppError('upload.blocked_content', `the archive was rejected: ${audit.blocked.join('; ')}`, 422);
    }

    const sourceHash = UploadService.archiveHash(html, archive.entries.map((e) => e.path));
    const key = `games/${sourceHash.slice(0, 12)}`;

    const existing = await this.db.catalog.findGameBySourceHash(sourceHash);
    if (existing) {
      // Do not re-store identical bytes; report the match so the editor can decide.
      return {
        key,
        sourceHash,
        entryPointUrl: existing.url,
        entryPointPath: entry.path,
        title: existing.title,
        files: archive.entries.filter((e) => !e.isDirectory).length,
        totalBytes: archive.totalBytes,
        sizeKb: Math.round(archive.totalBytes / 1024),
        warnings: audit.warnings,
        duplicateOf: { id: existing.id, slug: existing.slug, title: existing.title },
      };
    }

    const written: StoredObject[] = [];
    try {
      for (const file of archive.entries) {
        if (file.isDirectory) continue;
        const mime = UploadService.mimeFor(file.path);
        written.push(await this.storage.put(`${key}/${file.path}`, file.data, mime));
      }
    } catch (error) {
      // Partial uploads are garbage: clean up so storage never accumulates orphans.
      await Promise.allSettled(written.map((object) => this.storage.delete(object.key)));
      throw error;
    }

    const entryPointUrl = this.storage.publicUrl(`${key}/${entry.path}`);
    this.logger.log(`stored ${written.length} files (${archive.totalBytes} bytes) for ${originalName}`);

    return {
      key,
      sourceHash,
      entryPointUrl,
      entryPointPath: entry.path,
      title: UploadService.titleFromArchive(originalName, entry.basePrefix),
      files: written.length,
      totalBytes: archive.totalBytes,
      sizeKb: Math.round(archive.totalBytes / 1024),
      warnings: audit.warnings,
      duplicateOf: null,
      // Dimensions read from the entry HTML: a sensible default the editor can fix.
      dimensions: { width: UploadService.readDimension(html, 'width'), height: UploadService.readDimension(html, 'height') },
    };
  }

  /** Validate + store one artwork image and return its public URL. */
  async storeImage(input: { buffer: Buffer; originalName: string; kind: 'thumbnail' | 'banner' | 'avatar' | 'gallery' }): Promise<{ url: string; key: string; size: number; mime: string }> {
    const { buffer, originalName, kind } = input;
    if (!buffer || buffer.byteLength === 0) throw new AppError('upload.empty', 'the uploaded file is empty', 400);
    if (buffer.byteLength > MAX_IMAGE_BYTES) throw new AppError('upload.too_large', `images must be under ${MAX_IMAGE_BYTES / 1024 / 1024} MB`, 413);
    if (/\.svg$/i.test(originalName)) {
      throw new AppError('upload.svg_rejected', 'SVG uploads are not accepted — export a PNG, JPEG or WebP instead', 415);
    }

    const mime = UploadService.detectImage(buffer, originalName);
    const hash = createHash('sha256').update(buffer).digest('hex');
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]!.replace('svg+xml', 'svg');
    const now = new Date();
    const key = `media/${kind}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${hash.slice(0, 20)}.${ext}`;
    const stored = await this.storage.put(key, buffer, mime);
    return { url: stored.url, key: stored.key, size: stored.size, mime };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Content-addressed: the same bytes always land at the same key. */
  static archiveHash(indexHtml: string, paths: string[]): string {
    const hash = createHash('sha256');
    hash.update(indexHtml);
    hash.update('\u0000');
    hash.update([...paths].sort().join('\n'));
    return hash.digest('hex');
  }

  static mimeFor(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    switch (ext) {
      case 'html':
      case 'htm': return 'text/html; charset=utf-8';
      case 'js':
      case 'mjs': return 'text/javascript; charset=utf-8';
      case 'json': return 'application/json; charset=utf-8';
      case 'css': return 'text/css; charset=utf-8';
      case 'png': return 'image/png';
      case 'jpg':
      case 'jpeg': return 'image/jpeg';
      case 'webp': return 'image/webp';
      case 'avif': return 'image/avif';
      case 'gif': return 'image/gif';
      case 'svg': return 'image/svg+xml';
      case 'ico': return 'image/x-icon';
      case 'mp3': return 'audio/mpeg';
      case 'ogg': return 'audio/ogg';
      case 'wav': return 'audio/wav';
      case 'mp4': return 'video/mp4';
      case 'webm': return 'video/webm';
      case 'wasm': return 'application/wasm';
      case 'woff': return 'font/woff';
      case 'woff2': return 'font/woff2';
      case 'ttf': return 'font/ttf';
      case 'txt': return 'text/plain; charset=utf-8';
      case 'xml': return 'application/xml';
      case 'glb': return 'model/gltf-binary';
      case 'gltf': return 'model/gltf+json';
      default: return 'application/octet-stream';
    }
  }

  /** Magic-byte sniffing: the declared content type is attacker-controlled. */
  static detectImage(buffer: Buffer, originalName: string): string {
    const starts = (bytes: number[]): boolean => bytes.every((byte, index) => buffer[index] === byte);
    if (starts(IMAGE_MAGIC.png!.bytes)) return 'image/png';
    if (starts(IMAGE_MAGIC.jpeg!.bytes)) return 'image/jpeg';
    if (starts(IMAGE_MAGIC.gif!.bytes)) return 'image/gif';
    if (starts(IMAGE_MAGIC.webp!.bytes) && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    // ISO-BMFF (AVIF/HEIF): 4-byte size, then "ftyp", then a brand.
    if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
      const brand = buffer.subarray(8, 12).toString('ascii');
      if (['avif', 'avis', 'mif1', 'msf1'].includes(brand)) return 'image/avif';
    }
    throw new AppError('upload.wrong_type', `could not recognise "${originalName}" as PNG, JPEG, GIF, WebP or AVIF`, 415);
  }

  static titleFromArchive(originalName: string, basePrefix: string): string {
    const raw = originalName.replace(/\.zip$/i, '') || basePrefix.replace(/\/$/, '');
    const words = raw
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return words.length > 0 ? words.charAt(0).toUpperCase() + words.slice(1) : 'Untitled game';
  }

  /** Best-effort canvas size from the entry HTML; the editor can correct it. */
  static readDimension(html: string, which: 'width' | 'height'): number | null {
    const patterns = [
      new RegExp(`(?:canvas|game)[^>]*\\b${which}\\s*=\\s*["']?(\\d{2,5})`, 'i'),
      new RegExp(`\\b${which}\\s*:\\s*(\\d{2,5})`, 'i'),
      new RegExp(`<canvas[^>]*\\b${which}\\s*=\\s*["']?(\\d{2,5})`, 'i'),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        const value = Number(match[1]);
        if (Number.isFinite(value) && value >= 100 && value <= 100_000) return value;
      }
    }
    return null;
  }
}
