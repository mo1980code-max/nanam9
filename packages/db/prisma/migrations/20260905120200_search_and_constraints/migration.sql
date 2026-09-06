-- ══════════════════════════════════════════════════════════════════════════
-- Voltade — search, integrity constraints and hot-path indexes
--
-- This migration is HAND-WRITTEN on purpose. Everything in it is something a
-- Prisma schema cannot express: a generated tsvector column, a functional
-- (expression) index, CHECK constraints, and a partial index. They live in a
-- second migration so `prisma migrate diff` on the first one stays clean, and
-- packages/db/test/schema-parity.test.ts knows about each of them by name (the
-- DB_MANAGED_EXTRAS allowlist) so "extra column" is a documented decision
-- rather than silent drift.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. Full-text search ──────────────────────────────────────────────────────
-- A GENERATED column cannot go stale: the moment an editor saves a title, the
-- search vector for that row is rebuilt by PostgreSQL, not by a cron job or an
-- application hook that someone will eventually forget.
--
-- 'simple' (not 'english') because the catalogue is Arabic-first: the English
-- configuration would apply English stemming and stop-words to Arabic text.
-- 'simple' splits on whitespace and lowercases, which is the correct baseline
-- for a mixed ar/en corpus. Arabic-aware ranking is Meilisearch's job when it is
-- enabled; this index is the zero-dependency fallback that must still work.
ALTER TABLE "games"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce("title", '')), 'A')
   || setweight(to_tsvector('simple', coalesce("title_en", '')), 'A')
   || setweight(to_tsvector('simple', coalesce("seo_keywords", '')), 'B')
   || setweight(to_tsvector('simple', coalesce("description", '')), 'C')
  ) STORED;

CREATE INDEX "games_search_vector_idx" ON "games" USING GIN ("search_vector");

ALTER TABLE "blog_posts"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce("title", '')), 'A')
   || setweight(to_tsvector('simple', coalesce("excerpt", '')), 'B')
   || setweight(to_tsvector('simple', coalesce("body", '')), 'C')
  ) STORED;

CREATE INDEX "blog_posts_search_vector_idx" ON "blog_posts" USING GIN ("search_vector");

-- Categories and tags are searched by prefix on every keystroke (instant search
-- dropdown), so they get a plain lower() index rather than a tsvector one.
CREATE INDEX "categories_name_lower_idx" ON "categories" (lower("name"));
CREATE INDEX "tags_name_lower_idx" ON "tags" (lower("name"));

-- ── 2. Case-insensitive uniqueness ───────────────────────────────────────────
-- A UNIQUE index in Postgres is byte-exact, so without these two indexes
-- "Admin@x.com" and "admin@x.com" would be two accounts — and the second one
-- would receive the password-reset mail for the first.
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" (lower("email")) WHERE "email" IS NOT NULL;
CREATE UNIQUE INDEX "users_username_lower_key" ON "users" (lower("username"));

-- Login and profile lookup are case-insensitive too.
CREATE INDEX "users_username_lower_idx" ON "users" (lower("username"), "status");

-- ── 3. Integrity constraints the application must not be able to break ───────
-- Every one of these has been a real bug in a marketplace script: a 0-star
-- rating that skews the average, a "like" stored as 5, a negative play counter
-- after a double decrement, an ad whose window ends before it starts.
ALTER TABLE "ratings"     ADD CONSTRAINT "ratings_stars_between_1_and_5" CHECK ("stars" BETWEEN 1 AND 5);
ALTER TABLE "likes"       ADD CONSTRAINT "likes_value_is_plus_or_minus_one" CHECK ("value" IN (1, -1));
ALTER TABLE "games"       ADD CONSTRAINT "games_counters_not_negative" CHECK (
    "plays" >= 0 AND "unique_plays" >= 0 AND "likes_count" >= 0 AND "dislikes_count" >= 0
    AND "rating_count" >= 0 AND "comments_count" >= 0 AND "favorites_count" >= 0
);
ALTER TABLE "games"       ADD CONSTRAINT "games_rating_avg_in_range" CHECK ("rating_avg" >= 0 AND "rating_avg" <= 5);
ALTER TABLE "games"       ADD CONSTRAINT "games_dimensions_positive" CHECK (
    ("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)
);
ALTER TABLE "games"       ADD CONSTRAINT "games_published_requires_date" CHECK (
    "status" <> 'published' OR "published_at" IS NOT NULL
);
ALTER TABLE "games"       ADD CONSTRAINT "games_slug_not_blank" CHECK (length(btrim("slug")) > 0);
ALTER TABLE "comments"    ADD CONSTRAINT "comments_body_not_blank" CHECK (length(btrim("body")) >= 1);
ALTER TABLE "comments"    ADD CONSTRAINT "comments_counts_not_negative" CHECK ("likes_count" >= 0 AND "dislikes_count" >= 0);
ALTER TABLE "categories"  ADD CONSTRAINT "categories_games_count_not_negative" CHECK ("games_count" >= 0);
ALTER TABLE "categories"  ADD CONSTRAINT "categories_not_own_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
ALTER TABLE "comments"    ADD CONSTRAINT "comments_not_own_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
ALTER TABLE "comments"    ADD CONSTRAINT "comments_has_target" CHECK ("game_id" IS NOT NULL OR "blog_post_id" IS NOT NULL);
ALTER TABLE "ads"         ADD CONSTRAINT "ads_window_is_ordered" CHECK (
    "starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at"
);
ALTER TABLE "redirects"   ADD CONSTRAINT "redirects_status_is_a_redirect" CHECK ("status_code" IN (301, 302, 303, 307, 308));
ALTER TABLE "redirects"   ADD CONSTRAINT "redirects_not_a_loop" CHECK ("source_path" <> "target_path");
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_period_is_ordered" CHECK (
    "current_period_start" IS NULL OR "current_period_end" IS NULL OR "current_period_end" >= "current_period_start"
);
ALTER TABLE "plans"       ADD CONSTRAINT "plans_price_not_negative" CHECK ("price_cents" >= 0);
ALTER TABLE "payments"    ADD CONSTRAINT "payments_amount_positive" CHECK ("amount_cents" > 0);
ALTER TABLE "users"       ADD CONSTRAINT "users_xp_not_negative" CHECK ("xp" >= 0 AND "level" >= 1);
ALTER TABLE "users"       ADD CONSTRAINT "users_password_or_oauth" CHECK (
    "password_hash" IS NOT NULL OR "email" IS NOT NULL
);
ALTER TABLE "blog_posts"  ADD CONSTRAINT "blog_posts_reading_minutes_positive" CHECK ("reading_minutes" >= 1);
ALTER TABLE "game_plays"  ADD CONSTRAINT "game_plays_duration_not_negative" CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0);
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_counts_not_negative" CHECK ("views" >= 0 AND "plays" >= 0 AND "unique_visitors" >= 0);

-- ── 4. Hot-path partial indexes ──────────────────────────────────────────────
-- The catalogue pages only ever render published, non-deleted games. A partial
-- index over exactly those rows is a fraction of the size of a full index, so at
-- 20k+ games the working set stays in shared_buffers and the front page keeps
-- its <50ms query budget. Every ORDER BY below matches one of these.
CREATE INDEX "games_front_page_idx" ON "games" ("published_at" DESC, "id")
  WHERE "status" = 'published' AND "deleted_at" IS NULL;

CREATE INDEX "games_most_played_idx" ON "games" ("plays" DESC, "published_at" DESC)
  WHERE "status" = 'published' AND "deleted_at" IS NULL;

CREATE INDEX "games_top_rated_idx" ON "games" ("rating_avg" DESC, "rating_count" DESC)
  WHERE "status" = 'published' AND "deleted_at" IS NULL AND "rating_count" > 0;

CREATE INDEX "games_featured_idx" ON "games" ("featured", "plays" DESC)
  WHERE "status" = 'published' AND "deleted_at" IS NULL AND "featured" = true;

CREATE INDEX "games_free_idx" ON "games" ("plays" DESC)
  WHERE "status" = 'published' AND "deleted_at" IS NULL AND "premium" = false;

CREATE INDEX "games_visible_by_category_idx" ON "category_game" ("category_id", "position", "game_id");

-- Comment threads are always "visible comments of one game, newest first".
CREATE INDEX "comments_game_thread_idx" ON "comments" ("game_id", "parent_id", "created_at" DESC)
  WHERE "status" = 'visible' AND "deleted_at" IS NULL;

-- Moderation queue.
CREATE INDEX "comments_moderation_queue_idx" ON "comments" ("created_at")
  WHERE "status" = 'pending' AND "deleted_at" IS NULL;

-- The stats rollup worker scans a day of plays once per hour.
CREATE INDEX "game_plays_rollup_idx" ON "game_plays" ("started_at", "game_id");

-- "Continue playing" for a guest session.
CREATE INDEX "game_plays_session_recent_idx" ON "game_plays" ("session_id", "started_at" DESC)
  WHERE "session_id" IS NOT NULL;

-- Provider import: the worker only ever looks at un-imported rows of one provider.
CREATE INDEX "provider_items_pending_idx" ON "provider_items" ("provider_id", "fetched_at")
  WHERE "status" = 'new';

-- Sessions are swept for expiry on every login.
CREATE INDEX "sessions_expiry_idx" ON "sessions" ("expires_at") WHERE "revoked_at" IS NULL;

-- Unread notifications, per user — the bell icon's only query.
CREATE INDEX "notifications_unread_idx" ON "notifications" ("user_id", "created_at" DESC)
  WHERE "read_at" IS NULL;
