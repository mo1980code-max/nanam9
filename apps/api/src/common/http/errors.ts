/**
 * Typed errors the API throws.
 *
 * WHY NOT `throw new HttpException('nope', 404)`: a string message is not a
 * contract. Every error here carries a stable `code` (`game.not_found`) that the
 * Next.js app can switch on and translate, plus an HTTP status, and the exception
 * filter turns it into the documented `{ ok:false, error:{code,message} }` shape.
 * Frontend code that matches on codes survives copy changes; code that matches on
 * messages does not.
 */

import { HttpException, HttpStatus } from '@nestjs/common';

export type ErrorBody = {
  code: string;
  message: string;
  fields?: Record<string, string[]>;
  retryAfterSeconds?: number;
  details?: unknown;
};

export class AppError extends HttpException {
  /** `HttpException` keeps its own `status` private, so the public name differs. */
  readonly statusCode: number;

  constructor(
    public readonly code: string,
    message: string,
    statusCode: HttpStatus | number,
    public readonly extra: Omit<ErrorBody, 'code' | 'message'> = {},
  ) {
    super({ code, message, ...extra }, statusCode);
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'resource', message?: string) {
    super(`${what}.not_found`, message ?? `${what} not found`, HttpStatus.NOT_FOUND);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'authentication required', code = 'auth.unauthorized') {
    super(code, message, HttpStatus.UNAUTHORIZED);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'you do not have access to this resource', code = 'auth.forbidden') {
    super(code, message, HttpStatus.FORBIDDEN);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, fields?: Record<string, string[]>) {
    super(code, message, HttpStatus.CONFLICT, fields ? { fields } : {});
  }
}

export class ValidationError extends AppError {
  constructor(fields: Record<string, string[]>, message = 'validation failed') {
    super('validation.failed', message, HttpStatus.BAD_REQUEST, { fields });
  }
}

export class ThrottledError extends AppError {
  constructor(retryAfterSeconds: number, message = 'too many requests') {
    super('rate_limited', message, HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'upload exceeds the size limit') {
    super('upload.too_large', message, HttpStatus.PAYLOAD_TOO_LARGE);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(what: string, message?: string) {
    super(`${what}.unavailable`, message ?? `${what} is temporarily unavailable`, HttpStatus.SERVICE_UNAVAILABLE);
  }
}

/** Extracts the ErrorBody from anything Nest hands the exception filter. */
export function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof AppError) {
    return { status: error.statusCode, body: { code: error.code, message: error.message, ...error.extra } };
  }
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const status = error.getStatus();
    if (typeof response === 'string') {
      return { status, body: { code: httpCodeName(status), message: response } };
    }
    const r = response as Record<string, unknown>;
    // class-validator failures arrive as { message: string[], error: 'Bad Request' }
    if (Array.isArray(r.message)) {
      return { status, body: { code: 'validation.failed', message: 'validation failed', fields: groupValidationMessages(r.message as string[]) } };
    }
    return {
      status,
      body: {
        code: (r.code as string) ?? httpCodeName(status),
        message: (r.message as string) ?? error.message,
        ...(r.fields ? { fields: r.fields as Record<string, string[]> } : {}),
        ...(r.retryAfterSeconds ? { retryAfterSeconds: r.retryAfterSeconds as number } : {}),
      },
    };
  }
  return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: { code: 'server.error', message: 'internal server error' } };
}

function httpCodeName(status: number): string {
  switch (status) {
    case 400: return 'request.bad';
    case 401: return 'auth.unauthorized';
    case 403: return 'auth.forbidden';
    case 404: return 'request.not_found';
    case 409: return 'request.conflict';
    case 413: return 'upload.too_large';
    case 429: return 'rate_limited';
    default: return `http.${status}`;
  }
}

/** `["email must be an email", "username is too short"]` → `{email:[…],username:[…]}` */
export function groupValidationMessages(messages: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const raw of messages) {
    const message = String(raw);
    const field = message.split(' ')[0] ?? 'field';
    (out[field] ??= []).push(message);
  }
  return out;
}
