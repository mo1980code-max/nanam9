/**
 * Audit trail.
 *
 * Every privileged mutation goes through here: who did what, to which object, and
 * what the value was before and after. This is not decoration — it is the answer to
 * "why did 400 games disappear at 3am?" and the evidence an operator needs before
 * trusting a self-update or a bulk import.
 *
 * Design choices:
 *  · FIRE AND FORGET with a logged failure. An audit write must never be the reason
 *    a user-facing request 500s, and it must never be silently dropped either — so
 *    failures are logged at error level with the payload shape.
 *  · `before`/`after` are diffed to the changed keys only. Storing whole game rows
 *    per edit would balloon activity_logs, and nobody reads unchanged fields.
 *  · The actor is passed explicitly (there is no AsyncLocalStorage magic): a service
 *    method that cannot name its actor cannot write a trustworthy log line.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database } from '@voltade/db';
import { DATABASE } from '../database/database.module.js';

export type AuditContext = {
  actorId?: string | null;
  actorLabel?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type AuditEntry = {
  action: string;
  targetKind?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger('audit');

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  record(ctx: AuditContext, entry: AuditEntry): void {
    const payload = {
      actorId: ctx.actorId ?? null,
      actorLabel: ctx.actorLabel ?? null,
      action: entry.action,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      before: diffable(entry.before),
      after: diffable(entry.after),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ? String(ctx.userAgent).slice(0, 400) : null,
    };
    // Deliberately not awaited: see the header comment.
    void this.db.operations.logActivity(payload).catch((error: unknown) => {
      this.logger.error(`audit write failed for ${entry.action}: ${(error as Error).message}`);
    });
  }

  /** Log a before/after pair reduced to the keys that actually changed. */
  recordChange(ctx: AuditContext, entry: Omit<AuditEntry, 'before' | 'after'> & { before: Record<string, unknown>; after: Record<string, unknown> }): void {
    const changed = changedKeys(entry.before, entry.after);
    this.record(ctx, {
      ...entry,
      before: pick(entry.before, changed),
      after: pick(entry.after, changed),
    });
  }
}

function diffable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      // activity_logs.before/after are jsonb — a 1 MB blob would be a denial of
      // service against our own audit table.
      return json && json.length > 20_000 ? { truncated: true, bytes: json.length } : value;
    } catch {
      return { unserialisable: true };
    }
  }
  return value;
}

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((key) => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null));
}

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = source?.[key] ?? null;
  return out;
}
