/**
 * One place where every failure becomes JSON.
 *
 * Rules:
 *  · the body is always `{ ok:false, error:{ code, message, fields?, retryAfterSeconds? } }`
 *    — the mirror image of the success envelope, so the frontend has one parser;
 *  · 5xx responses never leak internals: the stack goes to the log with a request
 *    id, and the client gets `server.error`. Leaking a Prisma/Postgres message is
 *    how an attacker learns your table names;
 *  · 4xx responses DO carry detail, because the client has to fix something
 *    (which field, how long to wait);
 *  · Postgres errors are translated: a unique violation on `games_slug_key`
 *    becomes `game.slug_taken` (409) instead of an opaque 500. That mapping is
 *    what makes "publish a game" feel correct in the admin UI.
 */

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { toErrorBody } from './errors.js';
import { CONFIG, type AppConfig } from '../../config/env.js';

/** Postgres SQLSTATE → an API-level error. Only the codes we can act on. */
const PG_ERRORS: Record<string, { status: HttpStatus; code: string; message: string }> = {
  '23505': { status: HttpStatus.CONFLICT, code: 'db.unique_violation', message: 'that value is already taken' },
  '23503': { status: HttpStatus.CONFLICT, code: 'db.foreign_key_violation', message: 'the referenced record does not exist' },
  '23514': { status: HttpStatus.BAD_REQUEST, code: 'db.check_violation', message: 'a value is out of its allowed range' },
  '22P02': { status: HttpStatus.BAD_REQUEST, code: 'db.invalid_input', message: 'a value has the wrong type' },
  '42601': { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'server.error', message: 'internal server error' },
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('http');

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    if (!response || response.headersSent) return;

    const requestId = (request.headers['x-request-id'] as string) ?? randomUUID();
    const { status, body } = this.classify(exception);

    if (status >= 500) {
      // The stack is logged, never returned. In development it is also useful on
      // the console, which is why the level differs by environment.
      const where = `${request.method} ${request.originalUrl}`;
      this.logger.error(`${requestId} ${where} → ${status} ${body.code}`, exception instanceof Error ? exception.stack : String(exception));
    } else if (this.config.LOG_LEVEL === 'debug') {
      this.logger.debug(`${requestId} ${request.method} ${request.originalUrl} → ${status} ${body.code}: ${body.message}`);
    }

    response.status(status).json({
      ok: false,
      error: {
        ...body,
        // In development the caller gets the real message; in production a 500
        // says only "internal server error".
        ...(status >= 500 && this.config.isProduction ? { message: 'internal server error' } : {}),
      },
      ...(status >= 500 ? { requestId } : {}),
    });
  }

  private classify(exception: unknown): { status: number; body: { code: string; message: string; fields?: Record<string, string[]>; retryAfterSeconds?: number } } {
    const direct = toErrorBody(exception);
    if (direct.status !== HttpStatus.INTERNAL_SERVER_ERROR || direct.body.code !== 'server.error') return direct;

    // node-postgres wraps server errors with a `code` (SQLSTATE) and `constraint`.
    const pg = exception as { code?: string; constraint?: string; detail?: string; message?: string };
    if (pg && typeof pg.code === 'string' && PG_ERRORS[pg.code]) {
      const mapped = PG_ERRORS[pg.code]!;
      const field = constraintToField(pg.constraint);
      return {
        status: mapped.status,
        body: {
          // `games_slug_key` → `game.slug_taken`: specific enough for the admin UI
          // to highlight the right input.
          code: mapped.code === 'db.unique_violation' && field ? `${field.table}.${field.column}_taken` : mapped.code,
          message: mapped.code === 'db.unique_violation' && field ? `${field.column} is already used` : mapped.message,
          ...(pg.detail ? { fields: field ? { [field.column]: [mapped.message] } : undefined } : {}),
        },
      };
    }

    if (exception instanceof Error && /ECONNREFUSED|ETIMEDOUT|connection terminated/i.test(exception.message)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: { code: 'db.unavailable', message: 'the database is not reachable' },
      };
    }

    if (exception instanceof HttpException) return direct;
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: { code: 'server.error', message: exception instanceof Error ? exception.message : 'internal server error' } };
  }
}

/** `users_email_lower_key` → { table:'user', column:'email' } (singular table, plural-safe). */
function constraintToField(constraint?: string): { table: string; column: string } | null {
  if (!constraint) return null;
  const m = /^(.+?)_(.+?)_(key|idx)$/.exec(constraint);
  if (!m) return null;
  const table = m[1]!.replace(/s$/, '');
  const column = m[2]!.replace(/_lower$/, '');
  return { table, column };
}
