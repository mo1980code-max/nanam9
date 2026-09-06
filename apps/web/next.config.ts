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
 *  - `output: 'standalone'`: the Docker image ships only the traced runtime, not node_modules.
 *  - `poweredByHeader: false` + `compress`: small, but free.
 */
const cdnHost = process.env.CDN_HOST ?? 'cdn.voltade.example';
const r2PublicHost = process.env.R2_PUBLIC_HOST ?? 'r2.voltade.example';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  transpilePackages: ['@voltade/shared'],
  images: {
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [360, 480, 640, 768, 1024, 1280, 1536],
    imageSizes: [96, 160, 256, 384],
    minimumCacheTTL: 60 * 60 * 24 * 7,
    remotePatterns: [
      { protocol: 'https', hostname: cdnHost },
      { protocol: 'https', hostname: r2PublicHost },
      { protocol: 'https', hostname: '**.gameassets.dev' },
      { protocol: 'https', hostname: 'img.gamepix.com' },
      { protocol: 'https', hostname: 'cdn.gamemonetize.com' },
    ],
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
    ];
  },
};

export default nextConfig;
