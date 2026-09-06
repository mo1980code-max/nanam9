-- ══════════════════════════════════════════════════════════════════════════
-- Voltade — initial schema for PostgreSQL 16
--
-- GENERATED from packages/db/prisma/schema.prisma by @voltade/db (npm run
-- sql:generate). Do not hand-edit: edit the schema and regenerate, then
-- `npm run sql:generate -- --check` proves the two still agree.
-- ══════════════════════════════════════════════════════════════════════════

-- ── enums ────────────────────────────────────────────────────────────────

-- GameStatus
CREATE TYPE "game_status" AS ENUM (
    'draft',
    'pending_review',
    'published',
    'archived',
    'blocked'
);

-- GameKind
CREATE TYPE "game_kind" AS ENUM (
    'iframe',
    'html5_zip',
    'unity_webgl',
    'embed_html',
    'external'
);

-- GameOrientation
CREATE TYPE "game_orientation" AS ENUM (
    'any',
    'portrait',
    'landscape'
);

-- AgeRating
CREATE TYPE "age_rating" AS ENUM (
    'everyone',
    'everyone_10',
    'teen',
    'mature'
);

-- UserStatus
CREATE TYPE "user_status" AS ENUM (
    'pending',
    'active',
    'banned',
    'deleted'
);

-- OAuthProvider
CREATE TYPE "oauth_provider" AS ENUM (
    'google',
    'facebook',
    'discord',
    'apple',
    'github'
);

-- SessionKind
CREATE TYPE "session_kind" AS ENUM (
    'refresh',
    'api_token',
    'magic_link'
);

-- TagScope
CREATE TYPE "tag_scope" AS ENUM (
    'game',
    'blog'
);

-- AssetKind
CREATE TYPE "asset_kind" AS ENUM (
    'thumbnail',
    'banner',
    'screenshot',
    'icon',
    'package',
    'video'
);

-- CommentStatus
CREATE TYPE "comment_status" AS ENUM (
    'pending',
    'visible',
    'hidden',
    'spam',
    'deleted'
);

-- TargetKind
CREATE TYPE "target_kind" AS ENUM (
    'game',
    'comment',
    'blog_post',
    'user'
);

-- PlaylistVisibility
CREATE TYPE "playlist_visibility" AS ENUM (
    'private',
    'unlisted',
    'public'
);

-- DeviceKind
CREATE TYPE "device_kind" AS ENUM (
    'desktop',
    'mobile',
    'tablet',
    'unknown'
);

-- StatDimension
CREATE TYPE "stat_dimension" AS ENUM (
    'site',
    'game',
    'category',
    'source',
    'country',
    'device'
);

-- BadgeTier
CREATE TYPE "badge_tier" AS ENUM (
    'bronze',
    'silver',
    'gold',
    'platinum'
);

-- NotificationKind
CREATE TYPE "notification_kind" AS ENUM (
    'comment_reply',
    'comment_like',
    'achievement',
    'system',
    'moderation',
    'subscription'
);

-- AdPlacement
CREATE TYPE "ad_placement" AS ENUM (
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
    'preloader'
);

-- AdType
CREATE TYPE "ad_type" AS ENUM (
    'html',
    'adsense',
    'google_ad_manager',
    'prebid',
    'image',
    'script'
);

-- AdStatus
CREATE TYPE "ad_status" AS ENUM (
    'active',
    'paused',
    'scheduled',
    'expired',
    'archived'
);

-- ContentStatus
CREATE TYPE "content_status" AS ENUM (
    'draft',
    'published',
    'scheduled',
    'archived'
);

-- SettingType
CREATE TYPE "setting_type" AS ENUM (
    'string',
    'number',
    'boolean',
    'json',
    'html',
    'color',
    'image'
);

-- ReportReason
CREATE TYPE "report_reason" AS ENUM (
    'spam',
    'harassment',
    'hate',
    'sexual',
    'violence',
    'illegal',
    'copyright',
    'misleading',
    'other'
);

-- ReportStatus
CREATE TYPE "report_status" AS ENUM (
    'open',
    'reviewing',
    'action_taken',
    'dismissed'
);

-- PlanInterval
CREATE TYPE "plan_interval" AS ENUM (
    'month',
    'year',
    'lifetime'
);

-- SubscriptionStatus
CREATE TYPE "subscription_status" AS ENUM (
    'incomplete',
    'trialing',
    'active',
    'past_due',
    'canceled',
    'expired'
);

-- PaymentProvider
CREATE TYPE "payment_provider" AS ENUM (
    'stripe',
    'paypal'
);

-- PaymentStatus
CREATE TYPE "payment_status" AS ENUM (
    'pending',
    'succeeded',
    'failed',
    'refunded',
    'canceled'
);

-- ProviderKind
CREATE TYPE "provider_kind" AS ENUM (
    'gamemonetize',
    'gamedistribution',
    'poke',
    'rss',
    'json',
    'custom'
);

-- ProviderItemStatus
CREATE TYPE "provider_item_status" AS ENUM (
    'new',
    'imported',
    'duplicate',
    'rejected',
    'failed',
    'skipped'
);

-- ImportStatus
CREATE TYPE "import_status" AS ENUM (
    'queued',
    'running',
    'succeeded',
    'partial',
    'failed',
    'canceled'
);

-- SectionKind
CREATE TYPE "section_kind" AS ENUM (
    'hero',
    'carousel',
    'game_grid',
    'category_grid',
    'tag_cloud',
    'banner',
    'html',
    'leaderboard',
    'recent',
    'popular'
);

-- BackupKind
CREATE TYPE "backup_kind" AS ENUM (
    'database',
    'files',
    'full'
);

-- BackupStatus
CREATE TYPE "backup_status" AS ENUM (
    'pending',
    'running',
    'done',
    'failed'
);

-- ── tables ───────────────────────────────────────────────────────────────

CREATE TABLE "roles" (
    "id" VARCHAR(30) NOT NULL,
    "slug" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(255),
    "level" SMALLINT NOT NULL DEFAULT 20,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "permissions" (
    "id" VARCHAR(30) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "module" VARCHAR(40) NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "role_permissions" (
    "role_id" VARCHAR(30) NOT NULL,
    "permission_id" VARCHAR(30) NOT NULL,
    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id")
);

CREATE TABLE "users" (
    "id" VARCHAR(30) NOT NULL,
    "email" VARCHAR(190),
    "username" VARCHAR(40) NOT NULL,
    "display_name" VARCHAR(80),
    "avatar_url" VARCHAR(500),
    "password_hash" VARCHAR(255),
    "locale" VARCHAR(8) NOT NULL DEFAULT 'ar',
    "timezone" VARCHAR(60),
    "bio" VARCHAR(500),
    "website" VARCHAR(255),
    "status" "user_status" NOT NULL DEFAULT 'active',
    "role_id" VARCHAR(30) NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" SMALLINT NOT NULL DEFAULT 1,
    "plays_count" INTEGER NOT NULL DEFAULT 0,
    "comments_count" INTEGER NOT NULL DEFAULT 0,
    "two_factor_secret" VARCHAR(64),
    "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
    "two_factor_backup_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "email_verified_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "last_login_ip" VARCHAR(45),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "oauth_accounts" (
    "id" VARCHAR(30) NOT NULL,
    "user_id" VARCHAR(30) NOT NULL,
    "provider" "oauth_provider" NOT NULL,
    "provider_user_id" VARCHAR(190) NOT NULL,
    "email" VARCHAR(190),
    "name" VARCHAR(120),
    "avatar_url" VARCHAR(500),
    "access_token" VARCHAR(2000),
    "refresh_token" VARCHAR(2000),
    "token_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sessions" (
    "id" VARCHAR(30) NOT NULL,
    "user_id" VARCHAR(30) NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "kind" "session_kind" NOT NULL DEFAULT 'refresh',
    "user_agent" VARCHAR(400),
    "ip" VARCHAR(45),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "categories" (
    "id" VARCHAR(30) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "parent_id" VARCHAR(30),
    "name" VARCHAR(120) NOT NULL,
    "name_en" VARCHAR(120),
    "description" TEXT,
    "icon" VARCHAR(60),
    "thumbnail_url" VARCHAR(500),
    "color" VARCHAR(20),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "games_count" INTEGER NOT NULL DEFAULT 0,
    "seo_title" VARCHAR(200),
    "seo_description" VARCHAR(400),
    "seo_keywords" VARCHAR(400),
    "canonical_url" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "category_game" (
    "category_id" VARCHAR(30) NOT NULL,
    "game_id" VARCHAR(30) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "category_game_pkey" PRIMARY KEY ("category_id", "game_id")
);

CREATE TABLE "tags" (
    "id" VARCHAR(30) NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "scope" "tag_scope" NOT NULL DEFAULT 'game',
    "games_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tag_game" (
    "tag_id" VARCHAR(30) NOT NULL,
    "game_id" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tag_game_pkey" PRIMARY KEY ("tag_id", "game_id")
);

CREATE TABLE "games" (
    "id" VARCHAR(30) NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "title_en" VARCHAR(200),
    "description" TEXT,
    "description_en" TEXT,
    "instructions" TEXT,
    "developer" VARCHAR(120),
    "version" VARCHAR(30),
    "release_year" SMALLINT,
    "kind" "game_kind" NOT NULL DEFAULT 'iframe',
    "url" VARCHAR(1000) NOT NULL,
    "file_path" VARCHAR(500),
    "width" SMALLINT,
    "height" SMALLINT,
    "orientation" "game_orientation" NOT NULL DEFAULT 'any',
    "size_kb" INTEGER,
    "thumbnail_url" VARCHAR(500) NOT NULL,
    "banner_url" VARCHAR(500),
    "gallery" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" "game_status" NOT NULL DEFAULT 'draft',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "premium" BOOLEAN NOT NULL DEFAULT false,
    "age_rating" "age_rating" NOT NULL DEFAULT 'everyone',
    "provider_slug" VARCHAR(40),
    "provider_game_id" VARCHAR(120),
    "provider_url" VARCHAR(1000),
    "source_hash" VARCHAR(64),
    "plays" INTEGER NOT NULL DEFAULT 0,
    "unique_plays" INTEGER NOT NULL DEFAULT 0,
    "likes_count" INTEGER NOT NULL DEFAULT 0,
    "dislikes_count" INTEGER NOT NULL DEFAULT 0,
    "rating_avg" REAL NOT NULL DEFAULT 0,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "comments_count" INTEGER NOT NULL DEFAULT 0,
    "favorites_count" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMPTZ(6),
    "seo_title" VARCHAR(200),
    "seo_description" VARCHAR(400),
    "seo_keywords" VARCHAR(400),
    "canonical_url" VARCHAR(500),
    "noindex" BOOLEAN NOT NULL DEFAULT false,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "game_assets" (
    "id" VARCHAR(30) NOT NULL,
    "game_id" VARCHAR(30) NOT NULL,
    "kind" "asset_kind" NOT NULL DEFAULT 'thumbnail',
    "url" VARCHAR(500) NOT NULL,
    "storage_key" VARCHAR(500),
    "mime_type" VARCHAR(80),
    "width" SMALLINT,
    "height" SMALLINT,
    "size_bytes" BIGINT,
    "alt" VARCHAR(255),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "game_assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "comments" (
    "id" VARCHAR(30) NOT NULL,
    "game_id" VARCHAR(30),
    "blog_post_id" VARCHAR(30),
    "user_id" VARCHAR(30),
    "parent_id" VARCHAR(30),
    "author_name" VARCHAR(80),
    "author_email" VARCHAR(190),
    "author_ip_hash" VARCHAR(64),
    "body" TEXT NOT NULL,
    "status" "comment_status" NOT NULL DEFAULT 'pending',
    "likes_count" INTEGER NOT NULL DEFAULT 0,
    "dislikes_count" INTEGER NOT NULL DEFAULT 0,
    "reports_count" INTEGER NOT NULL DEFAULT 0,
    "edited_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "likes" (
    "id" VARCHAR(30) NOT NULL,
    "user_id" VARCHAR(30) NOT NULL,
    "target_kind" "target_kind" NOT NULL,
    "target_id" VARCHAR(30) NOT NULL,
    "value" SMALLINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "likes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ratings" (
    "id" VARCHAR(30) NOT NULL,
    "user_id" VARCHAR(30) NOT NULL,
    "game_id" VARCHAR(30) NOT NULL,
    "stars" SMALLINT NOT NULL,
    "review" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "favorites" (
    "id" VARCHAR(30) NOT NULL,
    "user_id" VARCHAR(30) NOT NULL,
    "game_id" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "playlists" (
    "id" VARCHAR(30) NOT NULL,
    "user_id" VARCHAR(30) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "visibility" "playlist_visibility" NOT NULL DEFAULT 'private',
    "cover_url" VARCHAR(500),
    "games_count" INTEGER NOT NULL DEFAULT 0,
    "share_token" VARCHAR(40),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "playlists_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "playlist_game" (
    "playlist_id" VARCHAR(30) NOT NULL,
    "game_id" VARCHAR(30) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "playlist_game_pkey" PRIMARY KEY ("playlist_id", "game_id")
);

CREATE TABLE "game_plays" (
    "id" BIGSERIAL NOT NULL,
    "game_id" VARCHAR(30) NOT NULL,
    "user_id" VARCHAR(30),
    "session_id" VARCHAR(64),
    "device" "device_kind" NOT NULL DEFAULT 'unknown',
    "country" VARCHAR(2),
    "referrer" VARCHAR(500),
    "utm_source" VARCHAR(80),
    "duration_ms" INTEGER,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "game_plays_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "daily_stats" (
    "id" BIGSERIAL NOT NULL,
    "day" DATE NOT NULL,
    "dimension" "stat_dimension" NOT NULL DEFAULT 'site',
    "key" VARCHAR(120) NOT NULL DEFAULT '',
    "game_id" VARCHAR(30),
    "views" INTEGER NOT NULL DEFAULT 0,
    "plays" INTEGER NOT NULL DEFAULT 0,
    "unique_visitors" INTEGER NOT NULL DEFAULT 0,
    "avg_duration_ms" INTEGER,
    "bounce_rate" REAL,
    CONSTRAINT "daily_stats_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "achievements" (
    "id" VARCHAR(30) NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(255),
    "icon" VARCHAR(60),
    "tier" "badge_tier" NOT NULL DEFAULT 'bronze',
    "xp" INTEGER NOT NULL DEFAULT 10,
    "rule" JSONB NOT NULL DEFAULT '{}',
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "achievements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_achievements" (
    "user_id" VARCHAR(30) NOT NULL,
    "achievement_id" VARCHAR(30) NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "unlocked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_achievements_pkey" PRIMARY KEY ("user_id", "achievement_id")
);

CREATE TABLE "xp_events" (
    "id" BIGSERIAL NOT NULL,
    "user_id" VARCHAR(30) NOT NULL,
    "amount" SMALLINT NOT NULL,
    "reason" VARCHAR(60) NOT NULL,
    "target_kind" "target_kind",
    "target_id" VARCHAR(30),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "xp_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notifications" (
    "id" BIGSERIAL NOT NULL,
    "user_id" VARCHAR(30) NOT NULL,
    "kind" "notification_kind" NOT NULL DEFAULT 'system',
    "title" VARCHAR(160) NOT NULL,
    "body" VARCHAR(500),
    "link" VARCHAR(500),
    "data" JSONB,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ads" (
    "id" VARCHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "placement" "ad_placement" NOT NULL,
    "type" "ad_type" NOT NULL DEFAULT 'html',
    "status" "ad_status" NOT NULL DEFAULT 'active',
    "code" TEXT,
    "image_url" VARCHAR(500),
    "link_url" VARCHAR(500),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "impressions" BIGINT NOT NULL DEFAULT 0,
    "clicks" BIGINT NOT NULL DEFAULT 0,
    "targeting" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "ads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "plans" (
    "id" VARCHAR(30) NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(400),
    "price_cents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "interval" "plan_interval" NOT NULL DEFAULT 'month',
    "removes_ads" BOOLEAN NOT NULL DEFAULT true,
    "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "stripe_price_id" VARCHAR(120),
    "paypal_plan_id" VARCHAR(120),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscriptions" (
    "id" VARCHAR(30) NOT NULL,
    "user_id" VARCHAR(30) NOT NULL,
    "plan_id" VARCHAR(30) NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'incomplete',
    "provider" "payment_provider" NOT NULL DEFAULT 'stripe',
    "provider_subscription_id" VARCHAR(190),
    "current_period_start" TIMESTAMPTZ(6),
    "current_period_end" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payments" (
    "id" BIGSERIAL NOT NULL,
    "user_id" VARCHAR(30) NOT NULL,
    "subscription_id" VARCHAR(30),
    "provider" "payment_provider" NOT NULL DEFAULT 'stripe',
    "provider_payment_id" VARCHAR(190),
    "amount_cents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'usd',
    "status" "payment_status" NOT NULL DEFAULT 'pending',
    "meta" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pages" (
    "id" VARCHAR(30) NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "title_en" VARCHAR(200),
    "body" TEXT,
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "template" VARCHAR(40) NOT NULL DEFAULT 'default',
    "status" "content_status" NOT NULL DEFAULT 'draft',
    "is_indexed" BOOLEAN NOT NULL DEFAULT true,
    "seo_title" VARCHAR(200),
    "seo_description" VARCHAR(400),
    "canonical_url" VARCHAR(500),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "blog_categories" (
    "id" VARCHAR(30) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "parent_id" VARCHAR(30),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "posts_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "blog_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "blog_posts" (
    "id" VARCHAR(30) NOT NULL,
    "slug" VARCHAR(200) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "excerpt" VARCHAR(500),
    "body" TEXT NOT NULL,
    "cover_image" VARCHAR(500),
    "author_id" VARCHAR(30) NOT NULL,
    "category_id" VARCHAR(30),
    "status" "content_status" NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMPTZ(6),
    "reading_minutes" SMALLINT NOT NULL DEFAULT 1,
    "views" INTEGER NOT NULL DEFAULT 0,
    "seo_title" VARCHAR(200),
    "seo_description" VARCHAR(400),
    "canonical_url" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "blog_posts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "blog_post_tag" (
    "post_id" VARCHAR(30) NOT NULL,
    "tag_id" VARCHAR(30) NOT NULL,
    CONSTRAINT "blog_post_tag_pkey" PRIMARY KEY ("post_id", "tag_id")
);

CREATE TABLE "settings" (
    "key" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,
    "type" "setting_type" NOT NULL DEFAULT 'string',
    "group" VARCHAR(40) NOT NULL DEFAULT 'general',
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "description" VARCHAR(255),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "sections" (
    "id" VARCHAR(30) NOT NULL,
    "page" VARCHAR(40) NOT NULL DEFAULT 'home',
    "kind" "section_kind" NOT NULL DEFAULT 'game_grid',
    "title" VARCHAR(160),
    "title_en" VARCHAR(160),
    "subtitle" VARCHAR(255),
    "config" JSONB NOT NULL DEFAULT '{}',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "themes" (
    "id" VARCHAR(30) NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "preview_url" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "themes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "redirects" (
    "id" VARCHAR(30) NOT NULL,
    "source_path" VARCHAR(500) NOT NULL,
    "target_path" VARCHAR(500) NOT NULL,
    "status_code" SMALLINT NOT NULL DEFAULT 301,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "redirects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reports" (
    "id" VARCHAR(30) NOT NULL,
    "reporter_id" VARCHAR(30),
    "target_kind" "target_kind" NOT NULL,
    "target_id" VARCHAR(30) NOT NULL,
    "reason" "report_reason" NOT NULL DEFAULT 'other',
    "details" VARCHAR(1000),
    "status" "report_status" NOT NULL DEFAULT 'open',
    "moderator_id" VARCHAR(30),
    "resolution" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "activity_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" VARCHAR(30),
    "actor_label" VARCHAR(120),
    "action" VARCHAR(80) NOT NULL,
    "target_kind" "target_kind",
    "target_id" VARCHAR(30),
    "before" JSONB,
    "after" JSONB,
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(400),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "providers" (
    "id" VARCHAR(30) NOT NULL,
    "slug" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" "provider_kind" NOT NULL DEFAULT 'custom',
    "base_url" VARCHAR(500),
    "feed_url" VARCHAR(500),
    "api_key" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sync_interval_minutes" INTEGER NOT NULL DEFAULT 360,
    "last_sync_at" TIMESTAMPTZ(6),
    "last_status" "import_status",
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provider_items" (
    "id" BIGSERIAL NOT NULL,
    "provider_id" VARCHAR(30) NOT NULL,
    "provider_game_id" VARCHAR(120) NOT NULL,
    "source_hash" VARCHAR(64) NOT NULL,
    "title" VARCHAR(200),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "provider_item_status" NOT NULL DEFAULT 'new',
    "game_id" VARCHAR(30),
    "error" VARCHAR(500),
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "imported_at" TIMESTAMPTZ(6),
    CONSTRAINT "provider_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "import_jobs" (
    "id" BIGSERIAL NOT NULL,
    "provider_id" VARCHAR(30) NOT NULL,
    "status" "import_status" NOT NULL DEFAULT 'queued',
    "triggered_by" VARCHAR(20) NOT NULL DEFAULT 'cron',
    "actor_id" VARCHAR(30),
    "cursor" VARCHAR(200),
    "fetched_count" INTEGER NOT NULL DEFAULT 0,
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "error" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "releases" (
    "id" VARCHAR(30) NOT NULL,
    "version" VARCHAR(30) NOT NULL,
    "channel" VARCHAR(20) NOT NULL DEFAULT 'stable',
    "notes" TEXT,
    "package_url" VARCHAR(500),
    "checksum_sha256" VARCHAR(64),
    "size_bytes" BIGINT,
    "is_mandatory" BOOLEAN NOT NULL DEFAULT false,
    "min_schema_version" INTEGER,
    "released_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "releases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "backups" (
    "id" VARCHAR(30) NOT NULL,
    "kind" "backup_kind" NOT NULL DEFAULT 'database',
    "status" "backup_status" NOT NULL DEFAULT 'pending',
    "path" VARCHAR(500),
    "storage_key" VARCHAR(500),
    "size_bytes" BIGINT,
    "checksum_sha256" VARCHAR(64),
    "trigger" VARCHAR(30) NOT NULL DEFAULT 'manual',
    "meta" JSONB,
    "error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- ── indexes ──────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "roles_slug_key" ON "roles"("slug");
CREATE UNIQUE INDEX "permissions_slug_key" ON "permissions"("slug");
CREATE INDEX "permissions_module_idx" ON "permissions"("module");
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE INDEX "users_status_role_id_idx" ON "users"("status", "role_id");
CREATE INDEX "users_xp_idx" ON "users"("xp");
CREATE UNIQUE INDEX "oauth_accounts_provider_provider_user_id_key" ON "oauth_accounts"("provider", "provider_user_id");
CREATE INDEX "oauth_accounts_user_id_idx" ON "oauth_accounts"("user_id");
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");
CREATE INDEX "categories_parent_id_sort_order_idx" ON "categories"("parent_id", "sort_order");
CREATE INDEX "categories_is_visible_sort_order_idx" ON "categories"("is_visible", "sort_order");
CREATE INDEX "category_game_game_id_idx" ON "category_game"("game_id");
CREATE INDEX "category_game_category_id_position_idx" ON "category_game"("category_id", "position");
CREATE UNIQUE INDEX "tags_slug_key" ON "tags"("slug");
CREATE INDEX "tags_scope_games_count_idx" ON "tags"("scope", "games_count");
CREATE INDEX "tag_game_game_id_idx" ON "tag_game"("game_id");
CREATE UNIQUE INDEX "games_slug_key" ON "games"("slug");
CREATE UNIQUE INDEX "games_source_hash_key" ON "games"("source_hash");
CREATE INDEX "games_status_published_at_idx" ON "games"("status", "published_at" DESC);
CREATE INDEX "games_status_plays_idx" ON "games"("status", "plays" DESC);
CREATE INDEX "games_status_rating_avg_idx" ON "games"("status", "rating_avg" DESC);
CREATE INDEX "games_status_created_at_idx" ON "games"("status", "created_at" DESC);
CREATE INDEX "games_featured_status_idx" ON "games"("featured", "status");
CREATE INDEX "games_provider_slug_provider_game_id_idx" ON "games"("provider_slug", "provider_game_id");
CREATE INDEX "game_assets_game_id_kind_sort_order_idx" ON "game_assets"("game_id", "kind", "sort_order");
CREATE INDEX "comments_game_id_status_created_at_idx" ON "comments"("game_id", "status", "created_at" DESC);
CREATE INDEX "comments_blog_post_id_status_created_at_idx" ON "comments"("blog_post_id", "status", "created_at" DESC);
CREATE INDEX "comments_parent_id_idx" ON "comments"("parent_id");
CREATE INDEX "comments_user_id_created_at_idx" ON "comments"("user_id", "created_at" DESC);
CREATE INDEX "comments_status_created_at_idx" ON "comments"("status", "created_at" DESC);
CREATE UNIQUE INDEX "likes_user_id_target_kind_target_id_key" ON "likes"("user_id", "target_kind", "target_id");
CREATE INDEX "likes_target_kind_target_id_idx" ON "likes"("target_kind", "target_id");
CREATE INDEX "likes_user_id_target_kind_idx" ON "likes"("user_id", "target_kind");
CREATE UNIQUE INDEX "ratings_user_id_game_id_key" ON "ratings"("user_id", "game_id");
CREATE INDEX "ratings_game_id_stars_idx" ON "ratings"("game_id", "stars");
CREATE UNIQUE INDEX "favorites_user_id_game_id_key" ON "favorites"("user_id", "game_id");
CREATE INDEX "favorites_game_id_idx" ON "favorites"("game_id");
CREATE INDEX "favorites_user_id_created_at_idx" ON "favorites"("user_id", "created_at" DESC);
CREATE UNIQUE INDEX "playlists_share_token_key" ON "playlists"("share_token");
CREATE UNIQUE INDEX "playlists_user_id_slug_key" ON "playlists"("user_id", "slug");
CREATE INDEX "playlists_visibility_updated_at_idx" ON "playlists"("visibility", "updated_at" DESC);
CREATE INDEX "playlist_game_game_id_idx" ON "playlist_game"("game_id");
CREATE INDEX "playlist_game_playlist_id_position_idx" ON "playlist_game"("playlist_id", "position");
CREATE INDEX "game_plays_game_id_started_at_idx" ON "game_plays"("game_id", "started_at" DESC);
CREATE INDEX "game_plays_user_id_started_at_idx" ON "game_plays"("user_id", "started_at" DESC);
CREATE INDEX "game_plays_session_id_started_at_idx" ON "game_plays"("session_id", "started_at" DESC);
CREATE INDEX "game_plays_started_at_idx" ON "game_plays"("started_at");
CREATE UNIQUE INDEX "daily_stats_day_dimension_key_key" ON "daily_stats"("day", "dimension", "key");
CREATE INDEX "daily_stats_dimension_day_idx" ON "daily_stats"("dimension", "day" DESC);
CREATE INDEX "daily_stats_game_id_day_idx" ON "daily_stats"("game_id", "day" DESC);
CREATE UNIQUE INDEX "achievements_slug_key" ON "achievements"("slug");
CREATE INDEX "user_achievements_achievement_id_idx" ON "user_achievements"("achievement_id");
CREATE INDEX "xp_events_user_id_created_at_idx" ON "xp_events"("user_id", "created_at" DESC);
CREATE INDEX "xp_events_reason_created_at_idx" ON "xp_events"("reason", "created_at" DESC);
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");
CREATE INDEX "ads_placement_status_priority_idx" ON "ads"("placement", "status", "priority" DESC);
CREATE INDEX "ads_status_starts_at_ends_at_idx" ON "ads"("status", "starts_at", "ends_at");
CREATE UNIQUE INDEX "plans_slug_key" ON "plans"("slug");
CREATE INDEX "plans_is_active_sort_order_idx" ON "plans"("is_active", "sort_order");
CREATE UNIQUE INDEX "subscriptions_provider_subscription_id_key" ON "subscriptions"("provider_subscription_id");
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");
CREATE INDEX "payments_user_id_created_at_idx" ON "payments"("user_id", "created_at" DESC);
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at" DESC);
CREATE UNIQUE INDEX "pages_slug_key" ON "pages"("slug");
CREATE INDEX "pages_status_sort_order_idx" ON "pages"("status", "sort_order");
CREATE UNIQUE INDEX "blog_categories_slug_key" ON "blog_categories"("slug");
CREATE INDEX "blog_categories_parent_id_sort_order_idx" ON "blog_categories"("parent_id", "sort_order");
CREATE UNIQUE INDEX "blog_posts_slug_key" ON "blog_posts"("slug");
CREATE INDEX "blog_posts_status_published_at_idx" ON "blog_posts"("status", "published_at" DESC);
CREATE INDEX "blog_posts_category_id_status_idx" ON "blog_posts"("category_id", "status");
CREATE INDEX "blog_posts_author_id_idx" ON "blog_posts"("author_id");
CREATE INDEX "blog_post_tag_tag_id_idx" ON "blog_post_tag"("tag_id");
CREATE INDEX "settings_group_idx" ON "settings"("group");
CREATE INDEX "sections_page_is_visible_sort_order_idx" ON "sections"("page", "is_visible", "sort_order");
CREATE UNIQUE INDEX "themes_slug_key" ON "themes"("slug");
CREATE UNIQUE INDEX "redirects_source_path_key" ON "redirects"("source_path");
CREATE INDEX "redirects_is_active_idx" ON "redirects"("is_active");
CREATE INDEX "reports_status_created_at_idx" ON "reports"("status", "created_at" DESC);
CREATE INDEX "reports_target_kind_target_id_idx" ON "reports"("target_kind", "target_id");
CREATE INDEX "reports_reporter_id_idx" ON "reports"("reporter_id");
CREATE INDEX "activity_logs_created_at_idx" ON "activity_logs"("created_at" DESC);
CREATE INDEX "activity_logs_actor_id_created_at_idx" ON "activity_logs"("actor_id", "created_at" DESC);
CREATE INDEX "activity_logs_action_created_at_idx" ON "activity_logs"("action", "created_at" DESC);
CREATE INDEX "activity_logs_target_kind_target_id_idx" ON "activity_logs"("target_kind", "target_id");
CREATE UNIQUE INDEX "providers_slug_key" ON "providers"("slug");
CREATE UNIQUE INDEX "provider_items_source_hash_key" ON "provider_items"("source_hash");
CREATE INDEX "provider_items_provider_id_status_idx" ON "provider_items"("provider_id", "status");
CREATE INDEX "provider_items_fetched_at_idx" ON "provider_items"("fetched_at" DESC);
CREATE INDEX "import_jobs_provider_id_created_at_idx" ON "import_jobs"("provider_id", "created_at" DESC);
CREATE INDEX "import_jobs_status_idx" ON "import_jobs"("status");
CREATE UNIQUE INDEX "releases_version_key" ON "releases"("version");
CREATE INDEX "releases_channel_released_at_idx" ON "releases"("channel", "released_at" DESC);
CREATE INDEX "backups_created_at_idx" ON "backups"("created_at" DESC);

-- ── foreign keys (after every table exists, so order cannot matter) ──────

ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "category_game" ADD CONSTRAINT "category_game_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "category_game" ADD CONSTRAINT "category_game_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tag_game" ADD CONSTRAINT "tag_game_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tag_game" ADD CONSTRAINT "tag_game_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "game_assets" ADD CONSTRAINT "game_assets_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comments" ADD CONSTRAINT "comments_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comments" ADD CONSTRAINT "comments_blog_post_id_fkey" FOREIGN KEY ("blog_post_id") REFERENCES "blog_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "playlist_game" ADD CONSTRAINT "playlist_game_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "playlist_game" ADD CONSTRAINT "playlist_game_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "game_plays" ADD CONSTRAINT "game_plays_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "game_plays" ADD CONSTRAINT "game_plays_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_achievement_id_fkey" FOREIGN KEY ("achievement_id") REFERENCES "achievements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "blog_categories" ADD CONSTRAINT "blog_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "blog_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "blog_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "blog_post_tag" ADD CONSTRAINT "blog_post_tag_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "blog_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blog_post_tag" ADD CONSTRAINT "blog_post_tag_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_moderator_id_fkey" FOREIGN KEY ("moderator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "provider_items" ADD CONSTRAINT "provider_items_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_items" ADD CONSTRAINT "provider_items_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
