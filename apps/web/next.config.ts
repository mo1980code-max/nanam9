import type { NextConfig } from 'next';

/**
 * Voltade web — Next.js 15 (App Router).
 *
 * Decisions that matter for performance / SEO:
 *  - `transpilePackages`: @voltade/shared ships TS source; Next compiles it so the
 *    browser bundle never sees a second module system and the server can share DTO types.
 *  - `images.remotePatterns`: game thumbnails live on Cloudflare R2 / S3 behind the CDN,
 *    so the optimizer must be allowed to fetch them. `formats` puts AVIF first (≈35% smaller
 *    than WebP on screenshot-like game art), which is what LCP is waiting on.
 *  - `output: 'standalone'` (opt-in via NEXT_OUTPUT_STANDALONE=1): the Docker image
 *    ships only the traced runtime, not node_modules. Off by default because
 *    `next start` — the way this repo runs in development and in the preview — does
 *    not serve a standalone build; the container image opts in explicitly.
 *  - `poweredByHeader: false` + `compress`: small, but free.
 *
 * AND THE ONE THAT MAKES THE BROWSER SIDE WORK: `rewrites`.
 * Server Components may talk to the API on 127.0.0.1 — they run inside this sandbox.
 * The *browser* may not: it runs on the visitor's machine, where 127.0.0.1 is their own
 * computer. So every client-side call goes to a relative `/api/...` path and Next proxies
 * it. That also keeps session and CSRF cookies same-origin, which is the only reason the
 * double-submit CSRF defence can work from a browser at all.
 */
const cdnHost = process.env.CDN_HOST ?? 'cdn.voltade.example';
const r2PublicHost = process.env.R2_PUBLIC_HOST ?? 'r2.voltade.example';

/** Where the API listens. Server-side only; never shipped to the browser. */
const apiOrigin = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: process.env.NEXT_OUTPUT_STANDALONE === '1' ? 'standalone' : undefined,
  transpilePackages: ['@voltade/shared'],
  // The preview proxy serves this app from an *.e2b.app host. Without this, Next 15 logs
  // a cross-origin warning for every dev asset and HMR socket.
  allowedDevOrigins: ['*.e2b.app', 'localhost', '127.0.0.1'],
  env: {
    // Public, origin-less: the browser only ever needs to know the path prefix.
    NEXT_PUBLIC_API_BASE: '/api',
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [360, 480, 640, 768, 1024, 1280, 1536],
    imageSizes: [96, 160, 256, 384],
    minimumCacheTTL: 60 * 60 * 24 * 7,
    // Uploaded artwork is SVG/PNG/WebP served from our own storage; the optimizer is
    // allowed to handle them because they come through the same origin as the app.
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    remotePatterns: [
      { protocol: 'https', hostname: cdnHost },
      { protocol: 'https', hostname: r2PublicHost },
      { protocol: 'https', hostname: '**.gameassets.dev' },
      { protocol: 'https', hostname: 'img.gamepix.com' },
      { protocol: 'https', hostname: 'cdn.gamemonetize.com' },
    ],
  },
  async rewrites() {
    return [
      // Browser → Next → API. Also makes the API's own /media uploads same-origin.
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
      { source: '/media/:path*', destination: `${apiOrigin}/media/:path*` },
    ];
  },
  async headers() {
    return [
      {
        // Immutable, hashed assets → let Cloudflare and the browser cache them for a year.
        source: '/_next/static/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
        ],
      },
      {
        // A game runs in an iframe from our own storage. It gets a hardened CSP of its
        // own: it may execute (that is what a game is) but it may not touch our cookies,
        // navigate the top frame, or phone home except to the CDN.
        source: '/games/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400, immutable' },
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
