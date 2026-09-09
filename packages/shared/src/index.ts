/**
 * @voltade/shared — the contract between the API and the web app.
 *
 * Everything here is isomorphic on purpose: no `node:*` imports, no Prisma, no
 * Nest decorators. The same file is compiled into the NestJS bundle and into the
 * Next.js client bundle, so an enum value, a pagination rule or a JSON-LD shape
 * cannot disagree between the two sides. Anything that needs Node (crypto, dns,
 * pg) lives in the package that needs it and receives its dependency by
 * injection — see `createUrlGuard`, which takes a resolver function instead of
 * importing `node:dns`.
 */

export * from './api-types.js';
export * from './constants.js';
export * from './enums.js';
export * from './format.js';
export * from './pagination.js';
export * from './sanitize.js';
export * from './seo.js';
export * from './text.js';
export * from './url-guard.js';
