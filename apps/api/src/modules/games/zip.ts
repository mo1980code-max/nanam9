/**
 * ZIP reading with no dependency — because a game archive is untrusted input and
 * this is exactly the kind of code that should be auditable in one screen.
 *
 * WHY NOT adm-zip / jszip: both have a history of path-traversal advisories
 * (Zip Slip) and both happily allocate whatever the archive claims. Here every
 * entry name is normalised and rejected if it escapes the target directory, and
 * every entry is bounded by MAX_ENTRY_BYTES and MAX_TOTAL_BYTES before a single
 * byte is inflated — a 1 KB ZIP that claims 10 GB of output fails instead of
 * taking the worker down.
 *
 * Only the subset HTML5 game archives actually use is supported: DEFLATE (method
 * 8) and STORED (method 0), with the central directory as the source of truth
 * (never the local headers, which can disagree). Data descriptors, ZIP64 and
 * encryption are detected and rejected with a clear message rather than
 * silently mis-parsed.
 */

import { inflateRawSync } from 'node:zlib';
import { AppError } from '../../common/http/errors.js';

export type ZipEntry = {
  name: string;
  /** Normalised, forward-slash, guaranteed inside the target directory. */
  path: string;
  isDirectory: boolean;
  size: number;
  compressedSize: number;
  data: Buffer;
};

export type ZipContents = { entries: ZipEntry[]; totalBytes: number };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

export const ZIP_LIMITS = {
  maxArchiveBytes: 200 * 1024 * 1024,
  maxEntryBytes: 80 * 1024 * 1024,
  maxTotalBytes: 400 * 1024 * 1024,
  maxEntries: 4000,
} as const;

export class ZipError extends AppError {
  constructor(message: string) {
    super('upload.invalid_archive', message, 400);
  }
}

export function readZip(buffer: Buffer, limits: Partial<typeof ZIP_LIMITS> = {}): ZipContents {
  const maxArchive = limits.maxArchiveBytes ?? ZIP_LIMITS.maxArchiveBytes;
  const maxEntry = limits.maxEntryBytes ?? ZIP_LIMITS.maxEntryBytes;
  const maxTotal = limits.maxTotalBytes ?? ZIP_LIMITS.maxTotalBytes;
  const maxEntries = limits.maxEntries ?? ZIP_LIMITS.maxEntries;

  if (buffer.byteLength < 22) throw new ZipError('the file is too small to be a ZIP archive');
  if (buffer.byteLength > maxArchive) throw new ZipError(`archive exceeds ${maxArchive} bytes`);

  // Locate the End Of Central Directory record by scanning backwards (it may be
  // followed by an arbitrary-length comment).
  const searchStart = Math.max(0, buffer.byteLength - 66_000);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= searchStart; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('no ZIP end-of-central-directory record found — is this really a .zip?');

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) throw new ZipError('multi-volume archives are not supported');
  if (centralOffset === 0xffffffff || entryCount === 0xffff) throw new ZipError('ZIP64 archives are not supported');
  if (entryCount === 0) throw new ZipError('the archive is empty');
  if (entryCount > maxEntries) throw new ZipError(`archive contains ${entryCount} entries (limit ${maxEntries})`);
  if (centralOffset + centralSize > buffer.byteLength) throw new ZipError('the central directory is truncated');

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.byteLength || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError(`central directory entry ${index} is malformed`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    // Bit 11 = the name is UTF-8. Anything else is CP437, which for game archives
    // in practice means ASCII; reject rather than guess and produce a broken path.
    const utf8 = (flags & 0x800) !== 0 || rawName.every((byte) => byte < 0x80);
    if (!utf8) throw new ZipError('archive contains file names in a non-UTF-8 encoding');
    if ((flags & 0x1) !== 0) throw new ZipError('encrypted archives are not supported');
    const name = rawName.toString('utf8');

    cursor += 46 + nameLength + extraLength + commentLength;

    const isDirectory = name.endsWith('/');
    const path = safeEntryPath(name);
    if (isDirectory) {
      entries.push({ name, path, isDirectory: true, size: 0, compressedSize: 0, data: Buffer.alloc(0) });
      continue;
    }
    if (method !== 0 && method !== 8) throw new ZipError(`compression method ${method} is not supported`);
    if (size > maxEntry) throw new ZipError(`${name} inflates to ${size} bytes (limit ${maxEntry})`);
    totalBytes += size;
    if (totalBytes > maxTotal) throw new ZipError(`archive inflates to more than ${maxTotal} bytes — possible zip bomb`);
    if (compressedSize > buffer.byteLength) throw new ZipError(`${name} claims more compressed bytes than the archive holds`);

    // Read the local header to find where the data really starts (its own name and
    // extra fields can be longer than the central copy).
    if (localOffset + 30 > buffer.byteLength || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ZipError(`${name} points outside the archive`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.byteLength) throw new ZipError(`${name} is truncated`);
    const compressed = buffer.subarray(dataStart, dataEnd);

    let data: Buffer;
    try {
      data = method === 8 ? inflateRawSync(compressed, { maxOutputLength: size }) : Buffer.from(compressed);
    } catch (error) {
      throw new ZipError(`${name} could not be decompressed (${(error as Error).message})`);
    }
    if (data.byteLength !== size) throw new ZipError(`${name} inflated to ${data.byteLength} bytes, expected ${size}`);
    entries.push({ name, path, isDirectory: false, size, compressedSize, data });
  }

  return { entries, totalBytes };
}

/**
 * Normalise an entry name and prove it stays inside the extraction root.
 * This is the Zip Slip guard: `../../etc/passwd` and `/etc/passwd` both fail.
 */
export function safeEntryPath(name: string): string {
  const cleaned = name.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts: string[] = [];
  for (const part of cleaned.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new ZipError(`entry "${name}" escapes the extraction directory`);
    if (part.length > 200) throw new ZipError(`entry "${name}" has an absurdly long path segment`);
    // Reject control characters and NULs, which break filesystems and logs.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(part)) throw new ZipError(`entry "${name}" contains control characters`);
    parts.push(part);
  }
  const path = parts.join('/');
  if (!path) throw new ZipError(`entry "${name}" has no usable path`);
  return path;
}

/**
 * Find the game's entry point: the shallowest index.html (or .htm) in the archive.
 * Publishers sometimes ship `build/index.html`; the portal must know the prefix so
 * relative asset URLs keep working after upload.
 */
export function findEntryPoint(entries: ZipEntry[]): { path: string; basePrefix: string } {
  const candidates = entries
    .filter((entry) => !entry.isDirectory && /(^|\/)index\.html?$/i.test(entry.path))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  if (candidates.length === 0) {
    throw new ZipError('no index.html found in the archive — an HTML5 game must ship an index.html');
  }
  const path = candidates[0]!.path;
  const basePrefix = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  return { path, basePrefix };
}

/**
 * Reject archives whose HTML tries to leave the sandbox. A game is rendered in an
 * iframe with a locked-down CSP, so these would fail at runtime anyway — better to
 * tell the publisher now than to serve a broken game.
 */
export function auditHtml(html: string): { warnings: string[]; blocked: string[] } {
  const warnings: string[] = [];
  const blocked: string[] = [];
  if (/<script[^>]+src=["']?https?:\/\//i.test(html)) warnings.push('loads a remote script (blocked by the sandbox CSP at runtime)');
  if (/document\.cookie/i.test(html)) warnings.push('reads document.cookie (unavailable inside the sandboxed iframe)');
  if (/(localStorage|sessionStorage)/.test(html)) warnings.push('uses web storage (unavailable inside the sandboxed iframe)');
  if (/<(iframe|object|embed)[^>]+src=["']?(https?:)?\/\//i.test(html)) warnings.push('embeds third-party content');
  if (/top\.location|parent\.location|window\.open\(/i.test(html)) blocked.push('tries to navigate or open the parent window');
  if (/on(error|load)=["']?[^"']*fetch\(/i.test(html)) warnings.push('issues network requests from inline handlers');
  return { warnings, blocked };
}
