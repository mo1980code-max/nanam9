-- Blog i18n: the post's editorial content in English. All three columns are
-- NULLable on purpose — a post is publishable in Arabic alone; the web app
-- falls back to the Arabic field when the English one is empty (pick()).
ALTER TABLE "blog_posts" ADD COLUMN IF NOT EXISTS "title_en" VARCHAR(200);
ALTER TABLE "blog_posts" ADD COLUMN IF NOT EXISTS "excerpt_en" VARCHAR(500);
ALTER TABLE "blog_posts" ADD COLUMN IF NOT EXISTS "body_en" TEXT;
