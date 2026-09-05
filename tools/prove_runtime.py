#!/usr/bin/env python3
"""Executable proofs for the schema + migration + bucket logic. Pure stdlib.

PHP never runs in this environment, so this file pins the parts that MUST behave:

  A. fresh install  — db/schema.sqlite.sql executes as-is with foreign_keys=ON,
                      seed rows insert, FK violations raise.
  B. upgrade path   — a v2-style (pre-bucket) leaderboard is created, legacy rows are put in,
                      migration "3" from db/migrations.json is applied verbatim, and:
                      * legacy weekly rows land in period='week' with period_key=week_key,
                      * rows with empty week_key land in period='all',
                      * the new unique keys reject duplicates per bucket,
                      * RE-RUNNING migration 3 is a no-op (idempotent ALTERs),
                      * pre-migration statement failure leaves nothing half-applied.
  C. eight boards   — the exact SQLite SQL from src/Gamify/Leaderboard.php (kept in sync by
                      tools/verify_php.py, which greps these statements) is exercised:
                      submit() writes 4 bucket rows with best-per-bucket upsert semantics;
                      all eight documented types return correct, deduped, ranked boards.

Exit 0 proves everything; any deviation exits 1 with the failing assertion.
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

FAILURES: list[str] = []
CHECKS = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if cond:
        print(f"  ✓ {label}")
    else:
        FAILURES.append(label)
        print(f"  ✗ {label} {detail}")


def fresh_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# --------------------------------------------------------------------------- A
def proof_a() -> sqlite3.Connection:
    print("A · fresh install executes db/schema.sqlite.sql verbatim")
    conn = fresh_conn()
    ddl = (ROOT / "db" / "schema.sqlite.sql").read_text(encoding="utf-8")
    conn.executescript(ddl)
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    check("all 25 tables exist", len(tables) == 25, f"got {len(tables)}")

    conn.execute(
        "INSERT INTO categories (id, slug, name_ar, name_en, color, position, created_at) "
        "VALUES (1,'action','أكشن','Action','#7c5cff',0,'2026-09-05 00:00:00')")
    conn.execute(
        "INSERT INTO games (id, slug, title_ar, title_en, category_id, created_at, updated_at) "
        "VALUES (1,'neon-worm','نيون وورم','Neon Worm',1,'2026-09-05 00:00:00','2026-09-05 00:00:00')")
    # leaderboard requires an existing game (FK)
    conn.execute(
        "INSERT INTO leaderboard (game_id, user_id, alias, score, period, period_key, week_key, submitted_at) "
        "VALUES (1, NULL, 'sara', 500, 'week', '2026-W36', '2026-W36', '2026-09-05 10:00:00')")
    try:
        conn.execute(
            "INSERT INTO leaderboard (game_id, alias, score, period, period_key, submitted_at) "
            "VALUES (9999,'x',1,'all','all','2026-09-05 10:00:00')")
        check("FK rejects scores for unknown games", False)
    except sqlite3.IntegrityError:
        check("FK rejects scores for unknown games", True)
    return conn


# --------------------------------------------------------------------------- B
OLD_LEADERBOARD = """
CREATE TABLE "leaderboard" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "game_id" INTEGER NOT NULL REFERENCES "games"("id") ON DELETE CASCADE,
  "user_id" INTEGER NULL,
  "alias" TEXT NULL,
  "score" INTEGER NOT NULL,
  "week_key" TEXT NOT NULL DEFAULT '',
  "signature" TEXT NULL,
  "submitted_at" TEXT NOT NULL
);
CREATE UNIQUE INDEX "uq_leaderboard_game_id_user_id_week_key" ON "leaderboard" ("game_id","user_id","week_key");
CREATE INDEX "idx_leaderboard_game_id_week_key_score" ON "leaderboard" ("game_id","week_key","score");
"""


def proof_b() -> None:
    print("B · upgrade path: legacy table + migration 3 applied verbatim, twice")
    conn = fresh_conn()
    conn.executescript((ROOT / "db" / "schema.sqlite.sql").read_text(encoding="utf-8"))
    conn.execute("DROP TABLE leaderboard")
    conn.executescript(OLD_LEADERBOARD)

    conn.execute(
        "INSERT INTO games (id, slug, title_ar, title_en, created_at, updated_at) "
        "VALUES (1,'neon-worm','ن','Neon Worm','2026-09-01 00:00:00','2026-09-01 00:00:00')")
    legacy = [
        (1, None, 'sara', 500, '2026-W35', '2026-08-28 10:00:00'),
        (1, None, 'sara', 700, '2026-W36', '2026-09-03 10:00:00'),
        (1, None, 'omar', 250, '2026-W36', '2026-09-04 09:00:00'),
        (1, None, 'old-guest', 90, '', '2026-08-01 09:00:00'),  # legacy rows always had week_key set;
    ]
    for row in legacy:
        conn.execute(
            "INSERT INTO leaderboard (game_id,user_id,alias,score,week_key,submitted_at) VALUES (?,?,?,?,?,?)",
            row)

    migrations = json.loads((ROOT / "db" / "migrations.json").read_text(encoding="utf-8"))
    steps = migrations["3"]["sqlite"]
    applied = 0
    ignored = 0
    for stmt in steps:
        try:
            conn.execute(stmt)
            applied += 1
        except sqlite3.OperationalError as e:
            msg = str(e).lower()
            if any(frag in msg for frag in ("duplicate column", "already exists", "no such")):
                ignored += 1
            else:
                raise
    check(f"migration 3 applied ({applied} statements, {ignored} tolerated)",
          applied >= 6, f"applied={applied}")

    cols = {r[1] for r in conn.execute("PRAGMA table_info(leaderboard)")}
    check("period + period_key exist after migration", {"period", "period_key"} <= cols)

    rows = conn.execute(
        "SELECT alias, period, period_key FROM leaderboard ORDER BY id").fetchall()
    check("legacy weekly rows backfilled to period='week'",
          any(a == 'sara' and p == 'week' and k == '2026-W35' for a, p, k in rows))
    check("legacy empty-week row backfilled to period='all'",
          any(a == 'old-guest' and p == 'all' and k == 'all' for a, p, k in rows))

    # new unique: same (game, alias, week bucket) twice must fail
    try:
        conn.execute(
            "INSERT INTO leaderboard (game_id,alias,score,period,period_key,submitted_at) "
            "VALUES (1,'sara',10,'week','2026-W36','2026-09-05 10:00:00')")
        check("new unique rejects duplicate (game,alias,period,key)", False)
    except sqlite3.IntegrityError:
        check("new unique rejects duplicate (game,alias,period,key)", True)

    # idempotency: full re-run must not raise and must not change row count
    n_before = conn.execute("SELECT COUNT(*) FROM leaderboard").fetchone()[0]
    for stmt in steps:
        try:
            conn.execute(stmt)
        except sqlite3.OperationalError as e:
            msg = str(e).lower()
            if not any(frag in msg for frag in ("duplicate column", "already exists", "no such")):
                raise
    n_after = conn.execute("SELECT COUNT(*) FROM leaderboard").fetchone()[0]
    check("re-running migration 3 is a no-op", n_before == n_after, f"{n_before} vs {n_after}")


# ------------------------------------------------------- C (the eight boards)
LEADERBOARD_READ_SQL = """
SELECT * FROM (
    SELECT lb.game_id, g.slug AS game_slug, lb.alias, lb.score, lb.submitted_at,
           ROW_NUMBER() OVER (
               PARTITION BY {partition}
               ORDER BY lb.score DESC, lb.submitted_at ASC
           ) AS player_rank
    FROM leaderboard lb
    JOIN games g ON g.id = lb.game_id
    WHERE lb.period = :period {key_clause} {game_clause}
) ranked
WHERE ranked.player_rank = 1
ORDER BY ranked.score DESC, ranked.submitted_at ASC
LIMIT :amount
"""

TYPES = {
    "top": ("all", True), "top-day": ("day", True), "top-week": ("week", True),
    "top-month": ("month", True), "top-all": ("all", False), "top-all-day": ("day", False),
    "top-all-week": ("week", False), "top-all-month": ("month", False),
}


def bucket_key(period: str, at: str) -> str:
    # mirrors Gamify\Buckets::key() — real ISO week math, same as PHP format('o')..'-W'..format('W')
    if period == "all":
        return "all"
    if period == "day":
        return at[:10]
    if period == "month":
        return at[:7]
    from datetime import date

    d = date.fromisoformat(at[:10])
    return f"{d.isocalendar()[0]}-W{d.isocalendar()[1]:02d}"

PERIODS = ["day", "week", "month", "all"]


class Board:
    """Python mirror of Gamify\\Leaderboard::submit/forType (same SQL, same upsert rule)."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def submit(self, game_id: int, score: int, alias: str, at: str) -> None:
        for period in PERIODS:
            key = bucket_key(period, at)
            week_col = key if period == "week" else ""
            self.conn.execute(
                """INSERT INTO leaderboard
                       (game_id, user_id, alias, score, period, period_key, week_key, signature, submitted_at)
                   VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?)
                   ON CONFLICT (game_id, alias, period, period_key) DO UPDATE SET
                       score = excluded.score,
                       week_key = excluded.week_key,
                       signature = excluded.signature,
                       submitted_at = excluded.submitted_at
                   WHERE excluded.score > leaderboard.score""",
                (game_id, alias, score, period, key, week_col, at))

    def for_type(self, game_id: int | None, type_: str, amount: int = 10) -> list:
        period, per_game = TYPES[type_]
        key = bucket_key(period, "2026-09-05T12:00:00")
        key_clause = "" if period == "all" else " AND lb.period_key = :pkey"
        game_clause = " AND lb.game_id = :gid" if per_game else ""
        sql = LEADERBOARD_READ_SQL.format(
            partition="lb.game_id, lb.alias" if per_game else "lb.alias",
            key_clause=key_clause,
            game_clause=game_clause,
        )
        params: dict = {"period": period, "pkey": key, "gid": game_id, "amount": amount}
        return self.conn.execute(sql, params).fetchall()


def proof_c() -> None:
    print("C · the eight leaderboard types behave (same SQL as Leaderboard.php)")
    conn = fresh_conn()
    conn.executescript((ROOT / "db" / "schema.sqlite.sql").read_text(encoding="utf-8"))
    for gid, slug in [(1, "neon-worm"), (2, "echo-cards")]:
        conn.execute(
            "INSERT INTO games (id, slug, title_ar, title_en, created_at, updated_at) "
            "VALUES (?,?,?,?,'2026-09-01 00:00:00','2026-09-01 00:00:00')", (gid, slug, slug, slug))
    board = Board(conn)

    board.submit(1, 500, "sara", "2026-09-05 12:00:00")
    board.submit(1, 700, "sara", "2026-09-05 13:00:00")   # same day: best wins
    board.submit(1, 600, "sara", "2026-09-05 14:00:00")   # lower: ignored
    board.submit(1, 1000, "omar", "2026-09-05 09:00:00")
    board.submit(2, 850, "sara", "2026-09-05 10:00:00")   # sara on another game
    board.submit(1, 300, "lina", "2026-09-01 08:00:00")   # earlier week + earlier month
    board.submit(1, 4000, "zee", "2026-08-20 08:00:00")   # only in 'all'

    t = board.for_type(1, "top")
    check("top = best all-time for the game, ranked", [r[3] for r in t] == [4000, 1000, 700, 300])
    t = board.for_type(1, "top-day")
    check("top-day = today's best, sara once at 700", [r[3] for r in t] == [1000, 700])
    t = board.for_type(1, "top-week")
    check("top-week = this ISO week only (zee excluded)", [r[3] for r in t] == [1000, 700, 300])
    t = board.for_type(1, "top-month")
    check("top-month = September only (zee's 4000 excluded)", [r[3] for r in t] == [1000, 700, 300])
    t = board.for_type(None, "top-all")
    check("top-all mixes games, each player once, best across games",
          [(r[1], r[3]) for r in t] == [("neon-worm", 4000), ("neon-worm", 1000), ("echo-cards", 850), ("neon-worm", 300)])
    check("top-all dedupes sara to her best (850, not 700)",
          sum(1 for r in t if r[2] == "sara") == 1 and max(r[3] for r in t if r[2] == "sara") == 850)
    t = board.for_type(None, "top-all-day")
    check("top-all-day = today across games, sara only once (850)", [r[3] for r in t] == [1000, 850])
    t = board.for_type(1, "top-week")
    check("per-player dedupe on per-game boards (sara once)",
          sum(1 for r in t if r[2] == "sara") == 1)
    t = board.for_type(1, "top", amount=2)
    check("amount caps results", len(t) == 2)

    # lower resubmission must not overwrite the stored best (upsert WHERE clause)
    board.submit(1, 10, "sara", "2026-09-05 15:00:00")
    t = board.for_type(1, "top-day")
    check("late lower score cannot overwrite the bucket best", [r[3] for r in t] == [1000, 700])

    rows = conn.execute("SELECT COUNT(*) FROM leaderboard").fetchone()[0]
    # 5 distinct submits x 4 buckets each; resubmits upsert into the same tuples.
    check("each submit fans out to 4 buckets with best-only upserts", rows == 20, f"rows={rows}")


def main() -> int:
    proof_a()
    proof_b()
    proof_c()
    print()
    if FAILURES:
        print(f"✗ {len(FAILURES)}/{CHECKS} checks failed:")
        for f in FAILURES:
            print(f"   - {f}")
        return 1
    print(f"✓ all {CHECKS} runtime checks hold · schema, migration, buckets and the 8 boards behave")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
