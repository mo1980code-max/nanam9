-- The audit trail must never refuse to record an event.
--
-- activity_logs.target_kind was the shared "target_kind" enum (game | comment |
-- blog_post | user). The moment the taxonomy, playlist and moderation modules
-- started auditing their own entities, every INSERT failed with
--   invalid input value for enum target_kind: "category"
-- and because audit writes are deliberately fire-and-forget (an audit failure must
-- never roll back the action it describes), the result was a silently incomplete
-- history — the exact opposite of what an audit log is for.
--
-- A closed enum is right for likes and reports, where the set of target kinds is a
-- real domain constraint that the application switches on. It is wrong for a log
-- table, whose job is to record whatever the code did, including kinds added by a
-- future release. So: text for the log, enum kept everywhere it constrains behaviour.
ALTER TABLE "activity_logs"
  ALTER COLUMN "target_kind" DROP DEFAULT,
  ALTER COLUMN "target_kind" TYPE varchar(40) USING "target_kind"::text;

COMMENT ON COLUMN "activity_logs"."target_kind" IS
  'Free-form entity kind (game, category, tag, playlist, report, page, setting, ...). '
  'Deliberately not an enum: an audit row must never be rejected for naming a new entity.';

-- Auditing is read back as "everything that happened to this thing", so the pair is
-- indexed rather than the kind alone.
CREATE INDEX IF NOT EXISTS "activity_logs_target_kind_target_id_idx"
  ON "activity_logs" ("target_kind", "target_id");
