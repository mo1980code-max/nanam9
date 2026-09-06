/** Site-wide constants. One place to change a limit, a TTL or a cookie name. */

import type { SettingType } from './enums.js';

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
  /**
   * Public ceiling. A crawler can request any page size in a loop and the CDN caches
   * the response, so this is a response-weight limit as much as a database one.
   */
  maxPerPage: 60,
  /**
   * Staff ceiling. Triage screens (reports, activity, the user grid) legitimately offer
   * "100 rows" and are behind the RolesGuard, so they get a wider page than the public.
   */
  adminMaxPerPage: 100,
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
    /** The active theme is read on every page shell render, so it is cached longest. */
    theme: (scope: 'active' | 'all') => `theme:${scope}`,
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
/**
 * Fixed-window budgets. Windows are keyed by user id once a request is
 * authenticated (the rate-limit guard runs *after* the auth guard) and by IP
 * otherwise, so one noisy member can never exhaust a whole household's budget.
 */
export const RATE_LIMITS = {
  global: { windowSeconds: 60, max: 300 },
  /** Sign-ups and OAuth starts: per IP, because there is no user yet. */
  auth: { windowSeconds: 60, max: 10 },
  /**
   * Password logins, per IP — the credential-stuffing wall: it caps how many
   * *different* accounts one host can try.
   *
   * It is deliberately not the brute-force defence for a single account. That is
   * AuthService's per-account backoff (8 failures per 15 minutes, keyed on the
   * account), which still holds when an attacker rotates IP addresses. Keeping the
   * two separate is what lets this one be generous: a school, an office or a mobile
   * carrier NATs dozens of players behind one address, and 8 sign-ins per five
   * minutes would lock the whole building out.
   */
  login: { windowSeconds: 300, max: 20 },
  /**
   * Every authenticated write that has no bucket of its own: profile edits, playlist
   * and settings saves, taxonomy edits, moderation, publishing. One per second
   * sustained is a real ceiling on a compromised account, while still letting an
   * editor work through a 40-row admin grid without being interrupted. The writes
   * that are actually abused (comments, logins, sign-ups, imports) keep their own
   * tighter budgets below.
   */
  write: { windowSeconds: 60, max: 60 },
  /**
   * Comments are per-user over five minutes. 20 is generous enough for a lively
   * thread but still caps a compromised account; guests are additionally
   * pre-moderated and IP-fingerprinted, so the ceiling is not the only defence.
   */
  comment: { windowSeconds: 300, max: 20 },
  play: { windowSeconds: 60, max: 60 },
  search: { windowSeconds: 60, max: 60 },
  import: { windowSeconds: 3600, max: 12 },
  /**
   * Staff endpoints — reads and writes alike. These are already behind the
   * RolesGuard, a CSRF token and the audit log, so this budget is about capping the
   * blast radius of a compromised staff session, not about stopping spam: two
   * requests a second, sustained. Editors legitimately work faster than a player
   * ever needs to (saving a forty-row grid, publishing a batch of imports), which
   * is why they do not share the player `write` budget.
   */
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

/**
 * The settings catalogue: every key the product understands, with its factory value,
 * type, admin group, visibility and help text.
 *
 * WHY THIS LIVES HERE AND NOT IN THE SEEDER OR THE API: three consumers need the
 * same list — the seeder (factory state), the settings API (validation, defaults,
 * "is this key still at its factory value?") and the admin UI (which builds its tabs
 * from `group` and its help text from `description`). Two of them used to keep their
 * own copy, and the two copies had already drifted (`site.logo` vs `site.logoUrl`,
 * `social.commentsEnabled` vs `games.guestComments`) — a drift that shows up as a
 * setting the admin saves and the site ignores.
 *
 * `isPublic` decides whether the key is served to anonymous visitors by
 * `GET /api/settings`. Keys that look like credentials are additionally refused
 * `isPublic: true` at write time and filtered again at read time, so a mistaken flag
 * is not enough to publish a secret.
 */
export type SettingDefinition = {
  /** Factory value, used until an operator writes the key. */
  value: unknown;
  /** Drives coercion on write and on read. */
  type: SettingType;
  /** Admin tab; also the first segment of the key by convention. */
  group: string;
  isPublic: boolean;
  description: string;
};

export const SETTINGS_CATALOGUE: Record<string, SettingDefinition> = {
  // ── identity ──────────────────────────────────────────────────────────────
  'site.name': { value: 'Voltade', type: 'string', group: 'general', isPublic: true, description: 'اسم الموقع' },
  'site.nameEn': { value: 'Voltade', type: 'string', group: 'general', isPublic: true, description: 'Site name (English)' },
  'site.tagline': { value: 'بوابة ألعاب HTML5 — العب فورًا بدون تحميل', type: 'string', group: 'general', isPublic: true, description: 'الوصف المختصر' },
  'site.taglineEn': { value: 'Play instantly. No downloads.', type: 'string', group: 'general', isPublic: true, description: 'Short description (English)' },
  'site.baseUrl': { value: '', type: 'string', group: 'general', isPublic: false, description: 'الرابط الأساسي (يُستخدم في sitemap و JSON-LD) — يُشتق من APP_URL عند تركه فارغًا' },
  'site.locale': { value: 'ar', type: 'string', group: 'general', isPublic: true, description: 'اللغة الافتراضية للزائر الجديد' },
  'site.logoUrl': { value: '/brand/logo.svg', type: 'image', group: 'general', isPublic: true, description: 'شعار الموقع' },
  'site.ogImageUrl': { value: '/brand/og-default.svg', type: 'image', group: 'general', isPublic: true, description: 'صورة المشاركة الافتراضية (Open Graph)' },

  // ── games & social ────────────────────────────────────────────────────────
  'games.perPage': { value: 24, type: 'number', group: 'games', isPublic: true, description: 'عدد الألعاب في الصفحة الواحدة' },
  'games.commentsPerPage': { value: 20, type: 'number', group: 'games', isPublic: true, description: 'عدد التعليقات في الصفحة' },
  'games.guestComments': { value: true, type: 'boolean', group: 'games', isPublic: true, description: 'السماح للزوار بالتعليق (تخضع لإشراف مسبق)' },
  'games.commentModeration': { value: 'guests', type: 'string', group: 'games', isPublic: false, description: 'off | guests | all' },
  'games.autoPublishImports': { value: false, type: 'boolean', group: 'games', isPublic: false, description: 'نشر الألعاب المستوردة تلقائيًا أم وضعها في قائمة المراجعة' },
  'games.ratingsEnabled': { value: true, type: 'boolean', group: 'games', isPublic: true, description: 'إتاحة التقييم بالنجوم' },

  // ── users ─────────────────────────────────────────────────────────────────
  'users.registrationEnabled': { value: true, type: 'boolean', group: 'users', isPublic: true, description: 'السماح بإنشاء حسابات جديدة' },
  'users.oauth.google': { value: false, type: 'boolean', group: 'users', isPublic: false, description: 'تفعيل تسجيل الدخول عبر Google' },
  'users.oauth.facebook': { value: false, type: 'boolean', group: 'users', isPublic: false, description: 'تفعيل تسجيل الدخول عبر Facebook' },
  'users.oauth.discord': { value: false, type: 'boolean', group: 'users', isPublic: false, description: 'تفعيل تسجيل الدخول عبر Discord' },

  // ── SEO ───────────────────────────────────────────────────────────────────
  'seo.defaultTitle': { value: 'Voltade — العب ألعاب HTML5 مجانًا', type: 'string', group: 'seo', isPublic: true, description: 'العنوان الافتراضي للصفحات' },
  'seo.titleTemplate': { value: '%s · Voltade', type: 'string', group: 'seo', isPublic: true, description: 'قالب العنوان — %s يُستبدل بعنوان الصفحة' },
  'seo.defaultDescription': { value: 'آلاف ألعاب HTML5 المجانية تعمل مباشرة في المتصفح: أكشن، سباقات، ألغاز، رياضة وألعاب أطفال — بدون تحميل أو تثبيت.', type: 'string', group: 'seo', isPublic: true, description: 'الوصف الافتراضي لمحركات البحث' },
  'seo.keywords': { value: 'العاب html5, العاب فلاش, العاب مجانية, العاب اونلاين, arcade games, html5 games', type: 'string', group: 'seo', isPublic: true, description: 'كلمات مفتاحية افتراضية' },

  // ── design ────────────────────────────────────────────────────────────────
  'theme.slug': { value: 'voltade-neon', type: 'string', group: 'design', isPublic: true, description: 'السمة الافتراضية' },
  'theme.mode': { value: 'system', type: 'string', group: 'design', isPublic: true, description: 'light | dark | system' },
  'theme.customCursor': { value: false, type: 'boolean', group: 'design', isPublic: true, description: 'مؤشر مخصص' },

  // ── monetisation & analytics ──────────────────────────────────────────────
  'ads.enabled': { value: true, type: 'boolean', group: 'ads', isPublic: true, description: 'عرض الإعلانات للزوار غير المشتركين' },
  'ads.adsenseClient': { value: '', type: 'string', group: 'ads', isPublic: false, description: 'ca-pub-XXXXXXXXXXXXXXXX' },
  'ads.prebidEnabled': { value: false, type: 'boolean', group: 'ads', isPublic: false, description: 'تفعيل header bidding' },
  'games.interstitialEvery': { value: 4, type: 'number', group: 'ads', isPublic: false, description: 'عدد الجولات بين إعلان بيني وآخر' },
  'analytics.ga4': { value: '', type: 'string', group: 'analytics', isPublic: true, description: 'G-XXXXXXXXXX' },
  'analytics.cloudflareToken': { value: '', type: 'string', group: 'analytics', isPublic: false, description: 'رمز Cloudflare Web Analytics' },

  // ── platform ──────────────────────────────────────────────────────────────
  'pwa.enabled': { value: true, type: 'boolean', group: 'pwa', isPublic: true, description: 'تفعيل التطبيق القابل للتثبيت' },
  'import.cronEnabled': { value: false, type: 'boolean', group: 'import', isPublic: false, description: 'تشغيل الاستيراد التلقائي المجدول' },
  'maintenance.enabled': { value: false, type: 'boolean', group: 'maintenance', isPublic: true, description: 'وضع الصيانة: يعرض صفحة الصيانة لكل الزوار' },
  'maintenance.message': { value: 'نقوم بأعمال صيانة، نعود بعد قليل.', type: 'string', group: 'maintenance', isPublic: true, description: 'رسالة صفحة الصيانة' },
  /**
   * The one key whose value is code by design: analytics, GTM and ad tags go inside
   * `<head>` and must execute. It is the only namespace the sanitiser lets through
   * unsanitised, it still requires `settings.manage`, and every write is audited.
   */
  'integrations.headHtml': { value: '', type: 'html', group: 'integrations', isPublic: true, description: 'وسوم تُحقن داخل <head> (تحليلات، إعلانات). تُنفَّذ كما هي.' },
};

export const SETTING_KEYS = Object.keys(SETTINGS_CATALOGUE);
/** Groups in the order the admin tabs should appear. */
export const SETTING_GROUPS = ['general', 'seo', 'games', 'users', 'design', 'ads', 'analytics', 'pwa', 'import', 'maintenance', 'integrations'] as const;
