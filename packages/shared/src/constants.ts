/** Site-wide constants. One place to change a limit, a TTL or a cookie name. */

export const APP_NAME = 'Voltade';
export const APP_NAME_AR = 'فولتايد';

export const LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'ar';
/** Arabic first: the portal ships RTL and the `dir` attribute follows the locale. */
export const RTL_LOCALES: readonly Locale[] = ['ar'];

export const isRtl = (locale: string): boolean => RTL_LOCALES.includes(locale as Locale);

/** Hard limits. The API validates against these, the UI counts against them. */
export const LIMITS = {
  username: { min: 3, max: 40 },
  password: { min: 8, max: 128 },
  email: { max: 190 },
  gameTitle: { max: 200 },
  gameDescription: { max: 5000 },
  comment: { min: 2, max: 2000 },
  commentDepth: 6,
  review: { max: 1000 },
  playlistName: { max: 120 },
  categoryName: { max: 120 },
  categoryDepth: 5,
  tagsPerGame: 20,
  seoTitle: { max: 70 },
  seoDescription: { max: 170 },
  /** A single uploaded build. 512 MB is generous for HTML5 and stops a disk fill. */
  uploadZipBytes: 512 * 1024 * 1024,
  uploadImageBytes: 8 * 1024 * 1024,
  /** Entries a provider import may create in one job before it asks for a human. */
  importBatch: 200,
} as const;

export const PAGINATION = {
  defaultPerPage: 24,
  maxPerPage: 60,
  commentsPerPage: 20,
  searchPerPage: 20,
} as const;

/** Coarse hierarchy. `@Roles('admin')` means "level >= admin.level". */
export const ROLE_LEVELS = {
  user: 20,
  moderator: 40,
  editor: 60,
  admin: 80,
  'super-admin': 100,
} as const;
export type RoleSlug = keyof typeof ROLE_LEVELS;
export const ROLE_SLUGS = Object.keys(ROLE_LEVELS) as RoleSlug[];

/**
 * The permission catalogue. Seeded into `permissions`, wired to roles by the
 * seeder, and checked by PoliciesGuard. `module.action` naming keeps
 * `@Permissions('games.publish')` readable and makes "everything in games"
 * (`games.*`) a one-line rule.
 */
export const PERMISSIONS = [
  // games
  'games.view',
  'games.create',
  'games.update',
  'games.delete',
  'games.publish',
  'games.feature',
  'games.import',
  'games.upload',
  // taxonomy
  'categories.manage',
  'tags.manage',
  // social
  'comments.view',
  'comments.create',
  'comments.moderate',
  'comments.delete',
  'reports.view',
  'reports.resolve',
  // users
  'users.view',
  'users.update',
  'users.ban',
  'users.impersonate',
  'roles.manage',
  // cms
  'pages.manage',
  'blog.view',
  'blog.create',
  'blog.update',
  'blog.delete',
  'blog.publish',
  'sections.manage',
  'themes.manage',
  // monetisation
  'ads.view',
  'ads.manage',
  'plans.manage',
  'subscriptions.view',
  // system
  'settings.view',
  'settings.manage',
  'stats.view',
  'activity.view',
  'backups.manage',
  'updates.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Which role gets which permissions by default. Super admin is implicit `*`. */
export const ROLE_PERMISSIONS: Record<RoleSlug, readonly string[]> = {
  'super-admin': ['*'],
  admin: [
    'games.view',
    'games.create',
    'games.update',
    'games.delete',
    'games.publish',
    'games.feature',
    'games.import',
    'games.upload',
    'categories.manage',
    'tags.manage',
    'comments.view',
    'comments.moderate',
    'comments.delete',
    'reports.view',
    'reports.resolve',
    'users.view',
    'users.update',
    'users.ban',
    'pages.manage',
    'blog.view',
    'blog.create',
    'blog.update',
    'blog.delete',
    'blog.publish',
    'sections.manage',
    'themes.manage',
    'ads.view',
    'ads.manage',
    'plans.manage',
    'subscriptions.view',
    'settings.view',
    'settings.manage',
    'stats.view',
    'activity.view',
    'backups.manage',
  ],
  editor: [
    'games.view',
    'games.create',
    'games.update',
    'games.upload',
    'games.import',
    'categories.manage',
    'tags.manage',
    'blog.view',
    'blog.create',
    'blog.update',
    'pages.manage',
    'sections.manage',
    'comments.view',
    'comments.moderate',
    'reports.view',
    'stats.view',
  ],
  moderator: [
    'games.view',
    'comments.view',
    'comments.moderate',
    'comments.delete',
    'reports.view',
    'reports.resolve',
    'users.view',
    'activity.view',
  ],
  user: ['comments.create'],
} as const;

/** Cache keys + TTLs. One namespace prefix so a single Redis DB can be flushed
 *  per environment (`voltade:dev:*`) without touching anything else. */
export const CACHE = {
  ns: 'voltade',
  ttl: {
    settings: 300,
    sections: 300,
    categories: 600,
    gameCard: 120,
    gameDetail: 60,
    listing: 45,
    search: 30,
    stats: 120,
    ads: 300,
    theme: 600,
  },
  key: {
    settings: (scope: 'public' | 'all') => `settings:${scope}`,
    sections: (page: string) => `sections:${page}`,
    categories: (locale: string) => `categories:tree:${locale}`,
    game: (slug: string) => `game:${slug}`,
    listing: (hash: string) => `listing:${hash}`,
    search: (hash: string) => `search:${hash}`,
    stats: (range: string) => `stats:${range}`,
    ads: (placement: string) => `ads:${placement}`,
    rateLimit: (bucket: string) => `rl:${bucket}`,
    loginAttempts: (key: string) => `login:${key}`,
    otp: (key: string) => `otp:${key}`,
    oauthState: (state: string) => `oauth:state:${state}`,
    gameSession: (gameId: string) => `game:live:${gameId}`,
  },
} as const;

/** BullMQ queue names. Every heavy operation in the product is on one of these. */
export const QUEUES = {
  gameImport: 'game-import',
  media: 'media',
  mail: 'mail',
  search: 'search-index',
  stats: 'stats-rollup',
  notifications: 'notifications',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const COOKIES = {
  accessToken: 'voltade_at',
  refreshToken: 'voltade_rt',
  locale: 'voltade_locale',
  theme: 'voltade_theme',
  sidebar: 'voltade_sidebar',
  /** Anonymous play-session id — how guests get "continue playing" and how
   *  unique-player counts work without personal data. */
  playSession: 'voltade_sid',
  consent: 'voltade_consent',
} as const;

export const TOKEN_TTL = {
  accessSeconds: 15 * 60,
  refreshSeconds: 30 * 24 * 60 * 60,
  /** A password reset / email verification link. */
  actionSeconds: 60 * 60,
} as const;

/** Rate limits: [window seconds, max requests]. Login is the tightest because
 *  it is the only endpoint where an attacker gains by brute force. */
export const RATE_LIMITS = {
  global: { windowSeconds: 60, max: 300 },
  auth: { windowSeconds: 60, max: 10 },
  login: { windowSeconds: 300, max: 8 },
  write: { windowSeconds: 60, max: 30 },
  comment: { windowSeconds: 300, max: 10 },
  play: { windowSeconds: 60, max: 60 },
  search: { windowSeconds: 60, max: 60 },
  import: { windowSeconds: 3600, max: 12 },
  admin: { windowSeconds: 60, max: 120 },
} as const;

export const HTTP = {
  /** Interstitial ads are the highest-value slot; the frontend asks for it by name. */
  adPlacements: [
    'header',
    'header_bottom',
    'sidebar_top',
    'sidebar_bottom',
    'in_feed',
    'interstitial',
    'footer',
    'game_top',
    'game_side',
    'game_bottom',
    'blog_post',
    'preloader',
  ],
} as const;

export const XP = {
  play: 5,
  firstPlayOfDay: 15,
  comment: 3,
  commentLiked: 2,
  rating: 2,
  favorite: 1,
  playlist: 4,
  dailyLogin: 10,
  /** level = floor(sqrt(xp / 100)) + 1 → level 2 at 100 XP, level 10 at 8100. */
  levelFor: (xp: number): number => Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1,
} as const;

export const IMAGE_SIZES = {
  /** [w, h] pairs the thumbnail pipeline produces (WebP + AVIF). */
  thumb: [
    [320, 180],
    [480, 270],
    [640, 360],
  ],
  banner: [
    [960, 320],
    [1440, 480],
  ],
  icon: [
    [96, 96],
    [192, 192],
  ],
} as const;
