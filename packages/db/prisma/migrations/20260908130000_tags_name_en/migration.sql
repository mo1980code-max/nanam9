-- Tag i18n: English display name. NULLable — the Arabic `name` is the fallback
-- everywhere (pick()/localized()), so a tag works untouched until translated.
ALTER TABLE "tags" ADD COLUMN "name_en" VARCHAR(80);
