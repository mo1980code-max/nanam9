/**
 * Runtime mirrors of the Postgres enums in packages/db/prisma/schema.prisma.
 *
 * These are `as const` objects rather than TS enums so they survive bundling
 * into the browser, can be iterated (`Object.values`), and can be handed
 * straight to class-validator's `@IsIn(...)` / zod's `z.enum(...)` without a
 * conversion step. A test in packages/db asserts the value lists match the
 * enum definitions in the schema, so this file cannot quietly fall behind.
 */

export const GameStatus = {
  draft: 'draft',
  pendingReview: 'pending_review',
  published: 'published',
  archived: 'archived',
  blocked: 'blocked',
} as const;
export type GameStatus = (typeof GameStatus)[keyof typeof GameStatus];
export const GAME_STATUSES = Object.values(GameStatus);

export const GameKind = {
  iframe: 'iframe',
  html5Zip: 'html5_zip',
  unityWebgl: 'unity_webgl',
  embedHtml: 'embed_html',
  external: 'external',
} as const;
export type GameKind = (typeof GameKind)[keyof typeof GameKind];
export const GAME_KINDS = Object.values(GameKind);

export const GameOrientation = { any: 'any', portrait: 'portrait', landscape: 'landscape' } as const;
export type GameOrientation = (typeof GameOrientation)[keyof typeof GameOrientation];

export const AgeRating = {
  everyone: 'everyone',
  everyone10: 'everyone_10',
  teen: 'teen',
  mature: 'mature',
} as const;
export type AgeRating = (typeof AgeRating)[keyof typeof AgeRating];
export const AGE_RATINGS = Object.values(AgeRating);
export const AGE_RATING_LABELS: Record<AgeRating, { ar: string; en: string }> = {
  everyone: { ar: 'للجميع', en: 'Everyone' },
  everyone_10: { ar: '١٠+', en: 'Everyone 10+' },
  teen: { ar: '١٣+', en: 'Teen' },
  mature: { ar: '١٧+', en: 'Mature' },
};

export const UserStatus = {
  pending: 'pending',
  active: 'active',
  banned: 'banned',
  deleted: 'deleted',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const OAuthProvider = {
  google: 'google',
  facebook: 'facebook',
  discord: 'discord',
  apple: 'apple',
  github: 'github',
} as const;
export type OAuthProvider = (typeof OAuthProvider)[keyof typeof OAuthProvider];
export const OAUTH_PROVIDERS = Object.values(OAuthProvider);

export const SessionKind = { refresh: 'refresh', apiToken: 'api_token', magicLink: 'magic_link' } as const;
export type SessionKind = (typeof SessionKind)[keyof typeof SessionKind];

export const TagScope = { game: 'game', blog: 'blog' } as const;
export type TagScope = (typeof TagScope)[keyof typeof TagScope];

export const AssetKind = {
  thumbnail: 'thumbnail',
  banner: 'banner',
  screenshot: 'screenshot',
  icon: 'icon',
  package: 'package',
  video: 'video',
} as const;
export type AssetKind = (typeof AssetKind)[keyof typeof AssetKind];

export const CommentStatus = {
  pending: 'pending',
  visible: 'visible',
  hidden: 'hidden',
  spam: 'spam',
  deleted: 'deleted',
} as const;
export type CommentStatus = (typeof CommentStatus)[keyof typeof CommentStatus];

export const TargetKind = {
  game: 'game',
  comment: 'comment',
  blogPost: 'blog_post',
  user: 'user',
} as const;
export type TargetKind = (typeof TargetKind)[keyof typeof TargetKind];
export const TARGET_KINDS = Object.values(TargetKind);

export const PlaylistVisibility = { private: 'private', unlisted: 'unlisted', public: 'public' } as const;
export type PlaylistVisibility = (typeof PlaylistVisibility)[keyof typeof PlaylistVisibility];

export const DeviceKind = {
  desktop: 'desktop',
  mobile: 'mobile',
  tablet: 'tablet',
  unknown: 'unknown',
} as const;
export type DeviceKind = (typeof DeviceKind)[keyof typeof DeviceKind];

export const StatDimension = {
  site: 'site',
  game: 'game',
  category: 'category',
  source: 'source',
  country: 'country',
} as const;
export type StatDimension = (typeof StatDimension)[keyof typeof StatDimension];

export const BadgeTier = { bronze: 'bronze', silver: 'silver', gold: 'gold', platinum: 'platinum' } as const;
export type BadgeTier = (typeof BadgeTier)[keyof typeof BadgeTier];

export const NotificationKind = {
  commentReply: 'comment_reply',
  commentLike: 'comment_like',
  achievement: 'achievement',
  system: 'system',
  moderation: 'moderation',
  subscription: 'subscription',
} as const;
export type NotificationKind = (typeof NotificationKind)[keyof typeof NotificationKind];

export const AdPlacement = {
  header: 'header',
  headerBottom: 'header_bottom',
  sidebarTop: 'sidebar_top',
  sidebarBottom: 'sidebar_bottom',
  inFeed: 'in_feed',
  interstitial: 'interstitial',
  footer: 'footer',
  gameTop: 'game_top',
  gameSide: 'game_side',
  gameBottom: 'game_bottom',
  blogPost: 'blog_post',
  preloader: 'preloader',
} as const;
export type AdPlacement = (typeof AdPlacement)[keyof typeof AdPlacement];
export const AD_PLACEMENTS = Object.values(AdPlacement);

export const AdType = {
  html: 'html',
  adsense: 'adsense',
  googleAdManager: 'google_ad_manager',
  prebid: 'prebid',
  image: 'image',
  script: 'script',
} as const;
export type AdType = (typeof AdType)[keyof typeof AdType];

export const AdStatus = {
  active: 'active',
  paused: 'paused',
  scheduled: 'scheduled',
  expired: 'expired',
  archived: 'archived',
} as const;
export type AdStatus = (typeof AdStatus)[keyof typeof AdStatus];

export const ContentStatus = {
  draft: 'draft',
  published: 'published',
  scheduled: 'scheduled',
  archived: 'archived',
} as const;
export type ContentStatus = (typeof ContentStatus)[keyof typeof ContentStatus];

export const SettingType = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  json: 'json',
  html: 'html',
  color: 'color',
  image: 'image',
} as const;
export type SettingType = (typeof SettingType)[keyof typeof SettingType];

export const ReportReason = {
  spam: 'spam',
  harassment: 'harassment',
  hate: 'hate',
  sexual: 'sexual',
  violence: 'violence',
  illegal: 'illegal',
  copyright: 'copyright',
  misleading: 'misleading',
  other: 'other',
} as const;
export type ReportReason = (typeof ReportReason)[keyof typeof ReportReason];

export const ReportStatus = {
  open: 'open',
  reviewing: 'reviewing',
  actionTaken: 'action_taken',
  dismissed: 'dismissed',
} as const;
export type ReportStatus = (typeof ReportStatus)[keyof typeof ReportStatus];

export const PlanInterval = { month: 'month', year: 'year', lifetime: 'lifetime' } as const;
export type PlanInterval = (typeof PlanInterval)[keyof typeof PlanInterval];

export const SubscriptionStatus = {
  incomplete: 'incomplete',
  trialing: 'trialing',
  active: 'active',
  pastDue: 'past_due',
  canceled: 'canceled',
  expired: 'expired',
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export const PaymentProvider = { stripe: 'stripe', paypal: 'paypal' } as const;
export type PaymentProvider = (typeof PaymentProvider)[keyof typeof PaymentProvider];

export const PaymentStatus = {
  pending: 'pending',
  succeeded: 'succeeded',
  failed: 'failed',
  refunded: 'refunded',
  canceled: 'canceled',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const ProviderKind = {
  gamemonetize: 'gamemonetize',
  gamedistribution: 'gamedistribution',
  poke: 'poke',
  rss: 'rss',
  json: 'json',
  custom: 'custom',
} as const;
export type ProviderKind = (typeof ProviderKind)[keyof typeof ProviderKind];
export const PROVIDER_KINDS = Object.values(ProviderKind);

export const ProviderItemStatus = {
  new: 'new',
  imported: 'imported',
  duplicate: 'duplicate',
  rejected: 'rejected',
  failed: 'failed',
  skipped: 'skipped',
} as const;
export type ProviderItemStatus = (typeof ProviderItemStatus)[keyof typeof ProviderItemStatus];

export const ImportStatus = {
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  partial: 'partial',
  failed: 'failed',
  canceled: 'canceled',
} as const;
export type ImportStatus = (typeof ImportStatus)[keyof typeof ImportStatus];

export const SectionKind = {
  hero: 'hero',
  carousel: 'carousel',
  gameGrid: 'game_grid',
  categoryGrid: 'category_grid',
  tagCloud: 'tag_cloud',
  banner: 'banner',
  html: 'html',
  leaderboard: 'leaderboard',
  recent: 'recent',
  popular: 'popular',
} as const;
export type SectionKind = (typeof SectionKind)[keyof typeof SectionKind];

export const BackupKind = { database: 'database', files: 'files', full: 'full' } as const;
export type BackupKind = (typeof BackupKind)[keyof typeof BackupKind];

export const BackupStatus = { pending: 'pending', running: 'running', done: 'done', failed: 'failed' } as const;
export type BackupStatus = (typeof BackupStatus)[keyof typeof BackupStatus];
