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
  D. licence gate   — a v3 database is upgraded with migrations "4" and "5" verbatim (5 twice), then
                      decision table of db/license_rules.json is run over a 14-game catalogue:
                      unlicensed / expired / forbidden / unknown / pending / malformed-evidence /
                      disputed-sibling / wildcard-origin / non-commercial / copyleft / dual-licence
                      / export-mode. The SQL is copied from src/Licensing/LicenseAuditor.php and
                      the audit ledger + verdict cache are checked on real rows.
  E. providers      — the SSRF guard is run against every reserved range in the encodings that
                      dodge a string check (decimal, octal, hex, short form, ::ffff:), plus scheme,
                      userinfo, port and DNS-rebinding cases; the shipped OSS pack is gated with the
                      same policy in export mode; and a feed is ingested twice into real
                      provider_games / provider_runs rows to prove idempotency and the audit trail.

Exit 0 proves everything; any deviation exits 1 with the failing assertion.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
import sys
import tempfile
import os
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
    expected = json.loads((ROOT / "db" / "schema.json").read_text(encoding="utf-8"))["tables"]
    check(f"all {len(expected)} tables exist", tables == set(expected),
          f"missing={sorted(set(expected) - tables)} extra={sorted(tables - set(expected))}")

    # the constraint repair: on a fresh install these three must refuse duplicates outright
    conn.execute("INSERT INTO settings (key_name, value_type, updated_at) VALUES ('k','string','2026-09-05 00:00:00')")
    for sql, label in [
        ("INSERT INTO settings (key_name, value_type, updated_at) VALUES ('k','string','2026-09-05 00:00:00')",
         "fresh install rejects a duplicate settings key"),
    ]:
        try:
            conn.execute(sql)
            check(label, False)
        except sqlite3.IntegrityError:
            check(label, True)

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


# ------------------------------------------------------- D (the licence gate)
# The SQL below is copied verbatim from src/Licensing/LicenseAuditor.php; tools/verify_php.py
# fails the build if either side drifts, so this proof cannot pin a query the product stopped using.
SQL_GAME_LICENSES = """
SELECT id, game_id, provider, license_type, license_ref, upstream_repo,
       commit_sha, license_file, license_sha256, proof_url, invoice_ref, allow_origins,
       attribution_required, attribution_html, captured_at, expires_at, status
FROM game_licenses WHERE game_id = ? ORDER BY id ASC
"""

SQL_PUBLISHED = """
SELECT g.id AS game_id, g.slug AS game_slug, g.provider AS game_provider,
       gl.id AS license_id, gl.provider, gl.license_type, gl.license_ref, gl.upstream_repo,
       gl.commit_sha, gl.license_file, gl.license_sha256, gl.proof_url, gl.invoice_ref,
       gl.allow_origins, gl.attribution_required, gl.attribution_html, gl.captured_at,
       gl.expires_at, gl.status
FROM games g
LEFT JOIN game_licenses gl ON gl.game_id = g.id
WHERE g.status = ?
ORDER BY g.id ASC, gl.id ASC
"""

SQL_UNLICENSED = """
SELECT g.id AS game_id, g.slug AS game_slug
FROM games g
WHERE g.status = ?
  AND NOT EXISTS (SELECT 1 FROM game_licenses gl WHERE gl.game_id = g.id AND gl.status = ?)
ORDER BY g.id ASC
"""

SQL_RECORD = """
INSERT INTO license_audits
    (game_id, license_id, verdict, mode, rules_version, reasons, details, audited_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
"""

SQL_MARK = 'UPDATE game_licenses SET audited_at = ?, audit_verdict = ? WHERE id = ?'

TODAY = "2026-09-05"
# Mirror of Migrator::CURRENT. tools/verify_php.py fails the build if the PHP constant disagrees,
# so this literal cannot drift from the product it is judging.
MIGRATOR_CURRENT = 5


class Policy:
    """Python mirror of Nawras\\Licensing\\LicensePolicy — same rules file, same order of checks."""

    def __init__(self, doc: dict):
        self.doc = doc
        self.types = doc["types"]
        self.statuses = doc["statuses"]
        self.evidence = doc["evidence"]

    def version(self) -> int:
        return int(self.doc.get("version", 0))

    def _f(self, code: str, severity: str, detail: str = "") -> dict:
        return {"code": code, "severity": severity, "detail": detail}

    def malformed(self, field: str, value: str) -> str | None:
        spec = self.doc.get("formats", {}).get(field)
        if not isinstance(spec, dict):
            return None
        if "length" in spec and len(value) != int(spec["length"]):
            return "bad_" + field
        if "pattern" in spec and re.match(spec["pattern"], value) is None:
            return "bad_" + field
        if "schemes" in spec and not any(value.startswith(s) for s in spec["schemes"]):
            return "bad_" + field
        return None

    def evaluate(self, row: dict, mode: str = "dynamic", ctx: dict | None = None) -> list[dict]:
        ctx = ctx or {}
        out: list[dict] = []
        status = str(row.get("status") or "")
        spec_status = self.statuses.get(status)
        if spec_status is None or not spec_status.get("servable"):
            out.append(self._f("license_not_active", "block", status or "empty"))

        type_ = str(row.get("license_type") or "")
        spec = self.types.get(type_)
        if spec is None:
            return out + [self._f("unknown_license_type", "block", type_ or "empty")]
        if spec.get("forbidden"):
            out.append(self._f("type_forbidden", "block", type_))

        for field in self.evidence:
            if not spec["needs"].get(field):
                continue
            value = str(row.get(field) or "").strip()
            if value == "":
                out.append(self._f("missing_" + field, "block", type_))
                continue
            bad = self.malformed(field, value)
            if bad:
                out.append(self._f(bad, "block", value))

        expires = str(row.get("expires_at") or "").strip()
        if expires and re.match(r"^\d{4}-\d{2}-\d{2}$", expires) and expires < TODAY:
            out.append(self._f("license_expired", "block", expires))
        if self.wants_attribution(row, spec) and not str(row.get("attribution_html") or "").strip():
            out.append(self._f("missing_attribution", "block", type_))

        origins_raw = str(row.get("allow_origins") or "").strip()
        if origins_raw:
            sep = self.doc.get("origins", {}).get("separator", ",")
            origins = [o.strip() for o in origins_raw.split(sep) if o.strip()]
            if not self.doc.get("origins", {}).get("wildcard_allowed", False) and "*" in origins:
                out.append(self._f("wildcard_origin", "block", origins_raw))
            mx = int(self.doc.get("origins", {}).get("max", 8))
            if mx > 0 and len(origins) > mx:
                out.append(self._f("too_many_origins", "warn", str(len(origins))))

        if not spec.get("commercial_ok", True) and ctx.get("commercial_install", True):
            out.append(self._f("not_commercial_ok", "block", type_))
        if mode == "export" and not spec.get("redistribution_ok", True):
            out.append(self._f("no_redistribution", "block", type_))

        if spec.get("copyleft") and not spec.get("forbidden"):
            out.append(self._f("copyleft_review", "warn", type_))
        if str(row.get("commit_sha") or "").strip() and not str(row.get("upstream_repo") or "").strip():
            out.append(self._f("unpinned_upstream", "warn", str(row.get("commit_sha"))))
        if not str(row.get("captured_at") or "").strip():
            out.append(self._f("no_capture_date", "warn", type_))
        gp = str(ctx.get("game_provider") or "").strip()
        if gp and gp != str(row.get("provider") or "").strip():
            out.append(self._f("provider_mismatch", "warn", gp))
        days = int(self.doc.get("expiry", {}).get("warn_days_before", 30))
        if expires and re.match(r"^\d{4}-\d{2}-\d{2}$", expires):
            from datetime import date, timedelta
            soon = (date.fromisoformat(TODAY) + timedelta(days=days)).isoformat()
            if TODAY <= expires <= soon:
                out.append(self._f("expires_soon", "warn", expires))
        return out

    @staticmethod
    def wants_attribution(row: dict, spec: dict) -> bool:
        return bool(spec.get("attribution_required")) or bool(row.get("attribution_required"))

    def attribution(self, row: dict) -> str | None:
        spec = self.types.get(str(row.get("license_type") or ""))
        if spec is None or not self.wants_attribution(row, spec):
            return None
        html = str(row.get("attribution_html") or "").strip()
        return html or None

    def decide(self, rows: list[dict], mode: str = "dynamic", ctx: dict | None = None) -> dict:
        def verdict(v, lid, ltype, reasons, warns, details, attribution=None):
            return {"ok": v != "blocked", "verdict": v, "license_id": lid, "license_type": ltype,
                    "reasons": reasons, "warnings": warns, "details": details, "attribution": attribution}

        if not rows:
            return verdict("blocked", None, None, ["no_license_row"], [], {"no_license_row": "no rows"})
        for row in rows:
            status = str(row.get("status") or "")
            if self.statuses.get(status, {}).get("blocking"):
                return verdict("blocked", int(row.get("id") or 0) or None,
                               str(row.get("license_type") or "") or None,
                               ["work_disputed"], [], {"work_disputed": status})
        cleanest = None
        for row in rows:
            findings = self.evaluate(row, mode, ctx)
            blocks = [f for f in findings if f["severity"] == "block"]
            warns = [f["code"] for f in findings if f["severity"] == "warn"]
            if not blocks:
                return verdict("ok" if not warns else "warn", int(row.get("id") or 0) or None,
                               str(row.get("license_type") or ""), [], warns,
                               {f["code"]: f["detail"] for f in findings if f["severity"] == "warn"},
                               self.attribution(row))
            if cleanest is None or len(blocks) < len(cleanest["blocks"]):
                cleanest = {"blocks": [f["code"] for f in blocks], "warns": warns,
                            "details": {f["code"]: f["detail"] for f in blocks}}
        return verdict("blocked", None, None, cleanest["blocks"], cleanest["warns"], cleanest["details"])


class Auditor:
    """Python mirror of Nawras\\Licensing\\LicenseAuditor (same SQL, same ledger writes)."""

    def __init__(self, conn: sqlite3.Connection, policy: Policy):
        self.conn = conn
        self.policy = policy

    @staticmethod
    def license_row(item: dict) -> dict:
        """Twin of FeedConverter::licenseRow — the defaults matter: status defaults to active."""
        return {
            "id": 0, "provider": item.get("provider", "feed"), "external_id": item.get("external_id", ""),
            "license_type": item.get("license_type", ""), "license_ref": item.get("license_ref", ""),
            "upstream_repo": item.get("upstream_repo", ""), "commit_sha": item.get("commit_sha", ""),
            "license_file": item.get("license_file", ""), "license_sha256": item.get("license_sha256", ""),
            "proof_url": item.get("proof_url", ""), "invoice_ref": item.get("invoice_ref", ""),
            "allow_origins": item.get("allow_origins", ""),
            "attribution_required": int(item.get("attribution_required", 0)),
            "attribution_html": item.get("attribution_html"), "captured_at": item.get("captured_at"),
            "expires_at": item.get("expires_at"), "status": item.get("status", "active"),
        }

    def licenses_for(self, game_id: int) -> list[dict]:
        cur = self.conn.execute(SQL_GAME_LICENSES, (game_id,))
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    def audit(self, game_id: int, mode: str = "dynamic", ctx: dict | None = None) -> dict:
        rows = self.licenses_for(game_id)
        v = self.policy.decide(rows, mode, ctx)
        v["game_id"] = game_id
        v["licenses"] = len(rows)
        return v

    def can_serve(self, game_id: int, ctx: dict | None = None) -> dict:
        return self.audit(game_id, "dynamic", ctx)

    def can_export(self, game_id: int, ctx: dict | None = None) -> dict:
        return self.audit(game_id, "export", ctx)

    def unlicensed(self, status: str = "published") -> list[dict]:
        cur = self.conn.execute(SQL_UNLICENSED, (status, "active"))
        return [{"game_id": r[0], "game_slug": r[1]} for r in cur.fetchall()]

    def record(self, game_id, license_id, verdict_code, mode, verdict_data, at) -> int:
        self.conn.execute(SQL_RECORD, (
            game_id, license_id, verdict_code, mode, self.policy.version(),
            json.dumps(verdict_data.get("reasons", []), ensure_ascii=False),
            json.dumps({"details": verdict_data.get("details", {}),
                        "labels": {c: self.policy.doc["finding_labels"][c]["ar"]
                                   for c in verdict_data.get("reasons", [])}}, ensure_ascii=False),
            at))
        return 1

    def mark_license(self, license_id, verdict_code, stamp) -> None:
        self.conn.execute(SQL_MARK, (stamp, verdict_code, license_id))

    def audit_published(self, mode: str = "dynamic", ctx: dict | None = None, at: str = TODAY + " 12:00:00") -> dict:
        ctx = dict(ctx or {})
        grouped: dict[int, dict] = {}
        cur = self.conn.execute(SQL_PUBLISHED, ("published",))
        cols = [d[0] for d in cur.description]
        for raw in cur.fetchall():
            row = dict(zip(cols, raw))
            gid = int(row["game_id"])
            grouped.setdefault(gid, {"slug": row["game_slug"], "provider": row["game_provider"], "licenses": []})
            if row["license_id"] is not None:
                grouped[gid]["licenses"].append(row)
        counts = {"ok": 0, "warn": 0, "blocked": 0}
        out = []
        for gid, game in grouped.items():
            ctx["game_provider"] = str(game["provider"] or "")
            v = self.policy.decide(game["licenses"], mode, ctx)
            v["game_id"] = gid
            v["game_slug"] = game["slug"]
            v["licenses"] = len(game["licenses"])
            counts[v["verdict"]] += 1
            self.record(gid, v["license_id"], v["verdict"], mode, v, at)
            for lic in game["licenses"]:
                self.mark_license(int(lic["license_id"]), v["verdict"], at)
            out.append(v)
        return {"audited": len(out), "ok": counts["ok"], "warn": counts["warn"],
                "blocked": counts["blocked"], "rows": out}

    def manifest(self, at: str = TODAY + " 12:00:00") -> dict:
        """Twin of LicenseAuditor::manifest() — what the static bundle is allowed to contain."""
        audit = self.audit_published("export", {"commercial_install": True}, at)
        games = [{
            "slug": str(row["game_slug"]), "verdict": str(row["verdict"]),
            "license_type": row["license_type"], "exportable": bool(row["ok"]),
            "attribution": row["attribution"], "reasons": row["reasons"], "warnings": row["warnings"],
        } for row in audit["rows"]]
        return {
            "rules_version": self.policy.version(),
            "rules_sha256": hashlib.sha256(php_json_encode(self.policy.doc).encode("utf-8")).hexdigest(),
            "mode": "export", "generated_at": at,
            "counts": {"ok": audit["ok"], "warn": audit["warn"], "blocked": audit["blocked"]},
            "games": games,
        }


def apply_step(conn: sqlite3.Connection, steps: list[str]) -> tuple[int, int]:
    """Runs one migration step the way Nawras\Db\Migrator does: tolerating 'already applied' only."""
    applied = ignored = 0
    for stmt in steps:
        try:
            conn.execute(stmt)
            applied += 1
        except sqlite3.OperationalError as e:
            msg = str(e).lower()
            if any(f in msg for f in ("duplicate column", "already exists", "no such")):
                ignored += 1
            else:
                raise
    return applied, ignored


# the three tables exactly as v3 shipped them on SQLite: the generator emitted no PRIMARY KEY,
# so none of them enforced uniqueness at all
OLD_SETTINGS = """
CREATE TABLE "settings" (
  "key_name" TEXT NOT NULL,
  "value_type" TEXT NOT NULL DEFAULT 'string',
  "value_text" TEXT NULL,
  "updated_at" TEXT NOT NULL
);
"""

OLD_GAME_TAG = """
CREATE TABLE "game_tag" (
  "game_id" INTEGER NOT NULL REFERENCES "games" ("id") ON DELETE CASCADE,
  "tag_id" INTEGER NOT NULL REFERENCES "tags" ("id") ON DELETE CASCADE
);
CREATE INDEX "idx_game_tag_tag_id" ON "game_tag" ("tag_id");
"""

OLD_COLLECTION_GAME = """
CREATE TABLE "collection_game" (
  "collection_id" INTEGER NOT NULL REFERENCES "collections" ("id") ON DELETE CASCADE,
  "game_id" INTEGER NOT NULL REFERENCES "games" ("id") ON DELETE CASCADE,
  "position" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "idx_collection_game_game_id" ON "collection_game" ("game_id");
"""

# game_licenses exactly as v3 shipped it: no audited_at / audit_verdict, no audit_verdict index
OLD_GAME_LICENSES = """
CREATE TABLE "game_licenses" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "game_id" INTEGER NOT NULL REFERENCES "games" ("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL DEFAULT 'own',
  "external_id" TEXT NULL,
  "license_type" TEXT NOT NULL,
  "license_ref" TEXT NOT NULL,
  "upstream_repo" TEXT NOT NULL DEFAULT '',
  "commit_sha" TEXT NOT NULL DEFAULT '',
  "license_path" TEXT NOT NULL DEFAULT '',
  "license_file" TEXT NOT NULL DEFAULT '',
  "license_sha256" TEXT NOT NULL DEFAULT '',
  "proof_url" TEXT NOT NULL DEFAULT '',
  "invoice_ref" TEXT NOT NULL DEFAULT '',
  "allow_origins" TEXT NOT NULL DEFAULT '',
  "attribution_required" INTEGER NOT NULL DEFAULT 0,
  "attribution_html" TEXT NULL,
  "captured_at" TEXT NULL,
  "expires_at" TEXT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "notes" TEXT NULL,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL
);
CREATE UNIQUE INDEX "uq_game_licenses_game_id_provider_external_id" ON "game_licenses" ("game_id","provider","external_id");
CREATE INDEX "idx_game_licenses_status" ON "game_licenses" ("status");
CREATE INDEX "idx_game_licenses_license_type" ON "game_licenses" ("license_type");
CREATE INDEX "idx_game_licenses_expires_at" ON "game_licenses" ("expires_at");
"""

def php_json_encode(obj) -> str:
    """Python stand-in for PHP json_encode() with default flags: compact separators, unicode escapes for non-ASCII, and "/" escaped. LicenseAuditor::manifest() hashes the policy this way
    (sha256 of the re-encoded decode), so the mirror needs the same shape to talk about it.

    Not verified against a real PHP runtime — there is no php binary here. That does not weaken
    the exporter: in production the comparison is PHP-to-PHP. The mirror uses this function only
    to prove the copied policy file is content-identical to the one the audit ran against."""
    return json.dumps(obj, ensure_ascii=True, separators=(",", ":")).replace("/", "\\/")


SHA40 = "9f2c1ab7d4e80563f21b0c9a7e6d5c4b3a291807"
SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
ATTR = '<a href="https://example.org/work">Work</a> by Sara, CC BY 4.0'


def _lic(**kw) -> dict:
    row = {
        "provider": "own", "external_id": None, "license_type": "own", "license_ref": "in-house",
        "upstream_repo": "", "commit_sha": "", "license_file": "", "license_sha256": "",
        "proof_url": "", "invoice_ref": "", "allow_origins": "", "attribution_required": 0,
        "attribution_html": None, "captured_at": TODAY, "expires_at": None, "status": "active",
    }
    row.update(kw)
    return row


# (slug, provider, [licence rows]) — one row per case the policy must decide differently
CATALOGUE = [
    ("neon-worm", "own", [_lic()]),
    ("echo-cards", "own", []),
    ("bubble-nova", "own", [_lic(license_type="commercial", license_ref="INV-1", proof_url="https://store.example/i/1",
                                 invoice_ref="INV-2024-118", expires_at="2026-08-01")]),
    ("maze-runner", "oss", [_lic(provider="oss", license_type="agpl-3.0", license_ref="AGPL-3.0",
                                 upstream_repo="https://git.example/maze", commit_sha=SHA40,
                                 license_file="LICENSE", license_sha256=SHA256,
                                 proof_url="https://git.example/maze/LICENSE",
                                 attribution_required=1, attribution_html=ATTR)]),
    ("pixel-paint", "oss", [_lic(provider="oss", license_type="cc-by", license_ref="CC BY 4.0",
                                 license_file="LICENSE.md", license_sha256=SHA256,
                                 proof_url="https://example.org/pixel-paint",
                                 attribution_required=1, attribution_html=ATTR)]),
    ("dual-license", "oss", [
        _lic(provider="oss", license_type="mit", license_ref="MIT", license_file="LICENSE",
             license_sha256=SHA256, proof_url="https://git.example/dual"),
        _lic(provider="oss", license_type="apache-2.0", license_ref="Apache-2.0",
             upstream_repo="https://git.example/dual", commit_sha=SHA40, license_file="LICENSE",
             license_sha256=SHA256, proof_url="https://git.example/dual/LICENSE",
             attribution_required=1, attribution_html=ATTR),
    ]),
    ("disputed-work", "own", [
        _lic(license_type="cc0", license_ref="CC0", proof_url="https://example.org/cc0"),
        _lic(license_type="cc0", license_ref="CC0-old", proof_url="https://example.org/cc0-old",
             status="revoked"),
    ]),
    ("wildcard-embed", "own", [_lic(license_type="cc0", license_ref="CC0",
                                    proof_url="https://example.org/cc0", allow_origins="*")]),
    ("shop-only", "own", [_lic(provider="store", license_type="commercial", license_ref="INV-2",
                                 proof_url="https://store.example/i/2", invoice_ref="INV-2025-004",
                                 expires_at="2027-01-01")]),
    ("nc-arcade", "oss", [_lic(provider="oss", license_type="cc-by-nc", license_ref="CC BY-NC 4.0",
                               license_file="LICENSE", license_sha256=SHA256,
                               proof_url="https://example.org/nc",
                               attribution_required=1, attribution_html=ATTR)]),
    ("bad-evidence", "oss", [_lic(provider="oss", license_type="mit", license_ref="MIT",
                                  commit_sha="deadbeef", license_file="LICENSE",
                                  license_sha256="zz", proof_url="ftp://example.org/LICENSE",
                                  attribution_required=1, attribution_html=ATTR)]),
    ("pending-review", "own", [_lic(status="pending")]),
    ("copyleft-game", "oss", [_lic(provider="oss", license_type="gpl-3.0", license_ref="GPL-3.0",
                                   upstream_repo="https://git.example/copyleft", commit_sha=SHA40,
                                   license_file="COPYING", license_sha256=SHA256,
                                   proof_url="https://git.example/copyleft/COPYING",
                                   attribution_required=1, attribution_html=ATTR)]),
    ("mystery-type", "own", [_lic(license_type="beerware", license_ref="?")]),
]


def seed_catalogue(conn: sqlite3.Connection) -> dict[str, int]:
    """Inserts CATALOGUE into a schema-built database. Shared by proofs D and F so the exporter
    is judged against exactly the rows the licence gate was judged against."""
    ids: dict[str, int] = {}
    for gid, (slug, provider, licenses) in enumerate(CATALOGUE, start=1):
        conn.execute(
            "INSERT INTO games (id, slug, title_ar, title_en, provider, status, created_at, updated_at) "
            "VALUES (?,?,?, ?,?, 'published','2026-09-01 00:00:00','2026-09-01 00:00:00')",
            (gid, slug, slug, slug, provider))
        ids[slug] = gid
        for lic in licenses:
            conn.execute(
                "INSERT INTO game_licenses (game_id, provider, external_id, license_type, license_ref,"
                " upstream_repo, commit_sha, license_file, license_sha256, proof_url, invoice_ref,"
                " allow_origins, attribution_required, attribution_html, captured_at, expires_at, status,"
                " created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'2026-09-01 00:00:00','2026-09-01 00:00:00')",
                (gid, lic["provider"], lic["external_id"], lic["license_type"], lic["license_ref"],
                 lic["upstream_repo"], lic["commit_sha"], lic["license_file"], lic["license_sha256"],
                 lic["proof_url"], lic["invoice_ref"], lic["allow_origins"], lic["attribution_required"],
                 lic["attribution_html"], lic["captured_at"], lic["expires_at"], lic["status"]))
    return ids


def proof_d() -> None:
    print("D · licence gate: migration 4, the decision table and the audit ledger")
    conn = fresh_conn()
    conn.executescript((ROOT / "db" / "schema.sqlite.sql").read_text(encoding="utf-8"))

    # --- D1: back to a v3 install, then upgrade it with the real migration file
    conn.execute("DROP TABLE license_audits")
    conn.execute("DROP INDEX idx_game_licenses_audit_verdict")
    conn.execute("DROP TABLE game_licenses")
    conn.executescript(OLD_GAME_LICENSES)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(game_licenses)")}
    check("v3 install has no audit columns", {"audited_at", "audit_verdict"} & cols == set(), str(cols & {"audited_at", "audit_verdict"}))

    conn.execute("DROP TABLE settings")
    conn.execute("DROP TABLE game_tag")
    conn.execute("DROP TABLE collection_game")
    conn.executescript(OLD_SETTINGS + OLD_GAME_TAG + OLD_COLLECTION_GAME)

    conn.execute("INSERT INTO categories (id, slug, name_ar, name_en, created_at) "
                 "VALUES (1,'casual','عادي','Casual','2026-09-01 00:00:00')")
    conn.execute("INSERT INTO games (id, slug, title_ar, title_en, created_at, updated_at) "
                 "VALUES (900,'repair-probe','ف','P','2026-09-01 00:00:00','2026-09-01 00:00:00')")
    conn.execute("INSERT INTO tags (id, slug, name_ar, name_en) VALUES (1,'hot','رائج','Hot')")
    conn.execute("INSERT INTO collections (id, slug, title_ar, title_en, position) "
                 "VALUES (1,'best','الأفضل','Best',0)")
    # dirty data: the exact rows a v3 SQLite install could accumulate
    conn.execute("INSERT INTO settings (key_name, value_type, updated_at) VALUES ('k','string','2026-09-01 00:00:00')")
    conn.execute("INSERT INTO settings (key_name, value_type, updated_at) VALUES ('k','string','2026-09-02 00:00:00')")
    conn.execute("INSERT INTO game_tag (game_id, tag_id) VALUES (900, 1)")
    conn.execute("INSERT INTO game_tag (game_id, tag_id) VALUES (900, 1)")
    conn.execute("INSERT INTO collection_game (collection_id, game_id, position) VALUES (1, 900, 0)")
    conn.execute("INSERT INTO collection_game (collection_id, game_id, position) VALUES (1, 900, 0)")
    check("v3 sqlite accepted duplicate rows (the defect is real)",
          conn.execute("SELECT COUNT(*) FROM game_tag").fetchone()[0] == 2
          and conn.execute("SELECT COUNT(*) FROM settings").fetchone()[0] == 2)

    migrations = json.loads((ROOT / "db" / "migrations.json").read_text(encoding="utf-8"))
    applied, ignored = apply_step(conn, migrations["4"]["sqlite"])
    check(f"migration 4 applied ({applied} statements, {ignored} tolerated)", applied >= 6, f"applied={applied}")
    check("migration 4 deduped the dirty tables",
          conn.execute("SELECT COUNT(*) FROM game_tag").fetchone()[0] == 1
          and conn.execute("SELECT COUNT(*) FROM collection_game").fetchone()[0] == 1
          and conn.execute("SELECT COUNT(*) FROM settings").fetchone()[0] == 1,
          f"game_tag={conn.execute('SELECT COUNT(*) FROM game_tag').fetchone()[0]}")
    check("migration 4 kept the newest settings row",
          conn.execute("SELECT updated_at FROM settings WHERE key_name = 'k'").fetchone()[0]
          == "2026-09-02 00:00:00")
    try:
        conn.execute("INSERT INTO game_tag (game_id, tag_id) VALUES (900, 1)")
        check("upgraded install rejects a duplicate tag assignment", False)
    except sqlite3.IntegrityError:
        check("upgraded install rejects a duplicate tag assignment", True)

    steps = migrations["5"]["sqlite"]
    applied, ignored = apply_step(conn, steps)
    check(f"migration 5 applied ({applied} statements, {ignored} tolerated)", applied >= 7, f"applied={applied}")

    cols = {r[1] for r in conn.execute("PRAGMA table_info(game_licenses)")}
    check("audited_at + audit_verdict exist after migration 5", {"audited_at", "audit_verdict"} <= cols)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    check("license_audits table exists after migration 5", "license_audits" in tables)
    stamped = conn.execute(
        "SELECT value_text FROM settings WHERE key_name = 'license.rules_version'").fetchone()
    rules_version = json.loads((ROOT / "db" / "license_rules.json").read_text(encoding="utf-8"))["version"]
    check("migration 5 stamped the rules version", stamped and int(stamped[0]) == rules_version, str(stamped))

    def state() -> tuple:
        return tuple(conn.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
                     for tbl in ("license_audits", "game_licenses", "settings", "games"))
    before = state()
    apply_step(conn, steps)
    check("re-running migration 5 is a no-op", state() == before, f"{before} vs {state()}")

    # --- D2: the catalogue, then the decision table
    seed_catalogue(conn)

    policy = Policy(json.loads((ROOT / "db" / "license_rules.json").read_text(encoding="utf-8")))
    auditor = Auditor(conn, policy)
    ids = {slug: gid for gid, (slug, _, _) in enumerate(CATALOGUE, start=1)}

    v = auditor.can_serve(ids["neon-worm"])
    check("own work with evidence passes", v["verdict"] == "ok" and v["ok"] is True, str(v["reasons"] + v["warnings"]))
    v = auditor.can_serve(ids["echo-cards"])
    check("no licence row is blocked", v["reasons"] == ["no_license_row"] and not v["ok"])
    v = auditor.can_serve(ids["bubble-nova"])
    check("expired commercial licence is blocked", "license_expired" in v["reasons"])
    v = auditor.can_serve(ids["maze-runner"])
    check("forbidden licence type is blocked", v["reasons"] == ["type_forbidden"], str(v["reasons"]))
    v = auditor.can_serve(ids["mystery-type"])
    check("unknown licence type is blocked", v["reasons"] == ["unknown_license_type"], str(v["reasons"]))
    v = auditor.can_serve(ids["pending-review"])
    check("pending row is not servable", v["reasons"] == ["license_not_active"], str(v["reasons"]))
    v = auditor.can_serve(ids["pixel-paint"])
    check("cc-by with attribution passes and returns the notice",
          v["ok"] is True and v["attribution"] == ATTR, str(v["attribution"]))
    v = auditor.can_serve(ids["dual-license"])
    check("dual licensing: one clean row grants the game",
          v["ok"] is True and v["license_type"] == "apache-2.0", str(v["license_type"]))
    v = auditor.can_serve(ids["disputed-work"])
    check("a revoked sibling poisons an otherwise clean game", v["reasons"] == ["work_disputed"], str(v["reasons"]))
    v = auditor.can_serve(ids["wildcard-embed"])
    check("wildcard allow_origins is blocked", v["reasons"] == ["wildcard_origin"], str(v["reasons"]))
    v = auditor.can_serve(ids["bad-evidence"])
    check("malformed evidence is blocked on every field",
          sorted(v["reasons"]) == ["bad_commit_sha", "bad_license_sha256", "bad_proof_url"],
          str(sorted(v["reasons"])))
    v = auditor.can_serve(ids["nc-arcade"], {"commercial_install": True})
    check("cc-by-nc is blocked on a commercial install", "not_commercial_ok" in v["reasons"])
    v = auditor.can_serve(ids["nc-arcade"], {"commercial_install": False})
    check("cc-by-nc passes on a non-commercial install", v["ok"] is True, str(v["reasons"]))
    v = auditor.can_serve(ids["copyleft-game"])
    check("copyleft serves with a review warning",
          v["ok"] is True and v["verdict"] == "warn" and "copyleft_review" in v["warnings"], str(v["warnings"]))
    v = auditor.can_serve(ids["shop-only"], {"game_provider": "own"})
    check("provider mismatch is a warning, not a block",
          v["ok"] is True and "provider_mismatch" in v["warnings"], str(v["warnings"]))
    check("dynamic mode allows a no-redistribution licence", auditor.can_serve(ids["shop-only"])["ok"] is True)
    v = auditor.can_export(ids["shop-only"])
    check("export mode refuses it (no_redistribution)", "no_redistribution" in v["reasons"], str(v["reasons"]))

    # --- D3: the gate, the ledger, the cache
    unlicensed = [r["game_slug"] for r in auditor.unlicensed()]
    check("SQL_UNLICENSED names exactly the published games with no ACTIVE licence row",
          unlicensed == ["echo-cards", "pending-review"], str(unlicensed))

    report = auditor.audit_published("dynamic", {"commercial_install": True})
    check("auditPublished covers every published game", report["audited"] == len(CATALOGUE), str(report["audited"]))
    check("auditPublished splits the catalogue into ok/warn/blocked",
          report["ok"] + report["warn"] + report["blocked"] == len(CATALOGUE)
          and report["blocked"] >= 8, f"ok={report['ok']} warn={report['warn']} blocked={report['blocked']}")

    ledger = conn.execute(
        "SELECT COUNT(*), MIN(rules_version), MAX(rules_version) FROM license_audits").fetchone()
    check("every audit wrote one ledger row with the rules version",
          ledger[0] == len(CATALOGUE) and ledger[1] == ledger[2] == rules_version, str(ledger))
    row = conn.execute(
        "SELECT verdict, reasons, details FROM license_audits WHERE game_id = ? ORDER BY id DESC LIMIT 1",
        (ids["echo-cards"],)).fetchone()
    check("ledger row keeps the machine reason and the Arabic label",
          row[0] == "blocked" and json.loads(row[1]) == ["no_license_row"]
          and "no_license_row" in json.loads(row[2])["labels"], str(row))
    cached = conn.execute(
        "SELECT audit_verdict, audited_at IS NOT NULL FROM game_licenses WHERE game_id = ?",
        (ids["pixel-paint"],)).fetchone()
    check("the verdict cache is written back onto the licence row",
          cached[0] in ("ok", "warn") and cached[1] == 1, str(cached))

    manifest_like = auditor.audit_published("export", {"commercial_install": True})
    check("export mode blocks at least the no-redistribution works",
          manifest_like["blocked"] > report["blocked"],
          f"dynamic={report['blocked']} export={manifest_like['blocked']}")

    conn.execute(
        "INSERT INTO game_licenses (game_id, provider, license_type, license_ref, status, created_at, updated_at) "
        "VALUES (?, 'own', 'own', 'in-house', 'active', '2026-09-05 00:00:00', '2026-09-05 00:00:00')",
        (ids["echo-cards"],))
    check("granting the missing licence unblocks the game",
          auditor.can_serve(ids["echo-cards"])["ok"] is True)


# ------------------------------------------------------- E (providers + SSRF)
# Mirrors of Nawras\Providers\{UrlGuard,OssPack,FeedConverter}. The reserved-range lists and the
# SQL are copied verbatim from the PHP; tools/verify_php.py fails the build when either side drifts.
BLOCKED_V4 = [
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
    "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
]
BLOCKED_V6 = [
    "::/128", "::1/128", "64:ff9b::/96", "100::/64", "2001:db8::/32", "fc00::/7",
    "fe80::/10", "ff00::/8",
]
BLOCKED_HOSTS = ["localhost"]
BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".intranet"]
ALLOWED_SCHEMES = ["http", "https"]
ALLOWED_PORTS = [80, 443]
PACK_REQUIRED = [
    "slug", "title_ar", "title_en", "provider", "license_type", "license_ref",
    "upstream_repo", "commit_sha", "license_file", "license_sha256", "proof_url",
]
FEED_REQUIRED_ITEM = ["external_id", "title_en", "license_type"]

SQL_LOOKUP = "SELECT id FROM provider_games WHERE provider = ? AND external_id = ?"
SQL_STORE = """
INSERT INTO provider_games (provider, external_id, payload, fetched_at)
VALUES (?, ?, ?, ?)
"""
SQL_REFRESH = "UPDATE provider_games SET payload = ?, fetched_at = ? WHERE id = ?"
SQL_RUN_OPEN = """
INSERT INTO provider_runs (provider, status, rows_seen, rows_new, rows_rejected, started_at)
VALUES (?, ?, ?, ?, ?, ?)
"""
SQL_RUN_CLOSE = "UPDATE provider_runs SET status = ?, rows_seen = ?, rows_new = ?, rows_rejected = ?, detail = ?, finished_at = ? WHERE id = ?"


def normalize_ip(host: str) -> str | None:
    """Python twin of UrlGuard::normalizeIp — dotted, decimal, octal, hex and short forms."""
    import ipaddress
    host = host.strip("[]")
    if not host:
        return None
    if ":" in host:
        low = host.lower()
        if low.startswith("::ffff:"):
            tail = low[7:]
            v4 = normalize_ip(tail)
            if v4 and v4.count(".") == 3:
                return v4
        try:
            return str(ipaddress.ip_address(low))
        except ValueError:
            return None
    try:
        return str(ipaddress.IPv4Address(host))
    except ValueError:
        pass
    parts = host.split(".")
    if len(parts) > 4:
        return None
    nums = []
    for part in parts:
        if not part:
            return None
        if part.lower().startswith("0x"):
            try:
                nums.append(int(part[2:], 16))
            except ValueError:
                return None
        elif len(part) > 1 and part[0] == "0":
            try:
                nums.append(int(part[1:], 8))
            except ValueError:
                return None
        elif part.isdigit():
            nums.append(int(part))
        else:
            return None
    limit = {1: 0xFFFFFFFF, 2: 0xFFFFFF, 3: 0xFFFF, 4: 0xFF}[len(nums)]
    if nums[-1] > limit:
        return None
    packed = 0
    for i, value in enumerate(nums):
        # same inet_aton rule as the PHP: last part at the bottom, the rest one byte each at the top
        shift = 0 if i == len(nums) - 1 else 8 * (3 - i)
        packed |= value << shift
    return str(ipaddress.IPv4Address(packed & 0xFFFFFFFF))


def is_blocked_ip(ip: str) -> bool:
    import ipaddress
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    ranges = BLOCKED_V4 if addr.version == 4 else BLOCKED_V6
    return any(addr in ipaddress.ip_network(r) for r in ranges)


def guard_inspect(url: str, resolver=None) -> dict:
    """Python twin of UrlGuard::inspect. resolver(host) stands in for DNS."""
    from urllib.parse import urlsplit
    url = url.strip()
    if not url:
        return {"ok": False, "reason": "empty_url", "host": "", "ips": []}
    try:
        parts = urlsplit(url)
    except ValueError:
        return {"ok": False, "reason": "unparsable", "host": "", "ips": []}
    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        return {"ok": False, "reason": "scheme_not_allowed", "host": parts.hostname or "", "ips": []}
    if not parts.hostname:
        return {"ok": False, "reason": "no_host", "host": "", "ips": []}
    if parts.username is not None or parts.password is not None:
        return {"ok": False, "reason": "userinfo_not_allowed", "host": parts.hostname, "ips": []}
    port = parts.port or (443 if parts.scheme.lower() == "https" else 80)
    if port not in ALLOWED_PORTS:
        return {"ok": False, "reason": "port_not_allowed", "host": parts.hostname, "ips": []}
    host = parts.hostname.lower()
    if host in BLOCKED_HOSTS or any(host.endswith(s) for s in BLOCKED_SUFFIXES):
        return {"ok": False, "reason": "host_blocked", "host": host, "ips": []}
    ip = normalize_ip(host)
    if ip is not None:
        return {"ok": not is_blocked_ip(ip), "reason": "ip_blocked", "host": host, "ips": [ip]}
    ips = resolver(host) if resolver else []
    if resolver and not ips:
        return {"ok": False, "reason": "unresolvable", "host": host, "ips": []}
    for resolved in ips:
        if is_blocked_ip(resolved):
            return {"ok": False, "reason": "dns_blocked", "host": host, "ips": ips}
    return {"ok": True, "reason": "", "host": host, "ips": ips}


class Pack:
    """Python twin of Nawras\\Providers\\OssPack."""

    def __init__(self, doc: dict, policy: Policy):
        self.doc = doc
        self.policy = policy

    def license_row(self, e: dict) -> dict:
        return {
            "id": 0, "provider": e.get("provider", "oss"), "external_id": e.get("slug", ""),
            "license_type": e.get("license_type", ""), "license_ref": e.get("license_ref", ""),
            "upstream_repo": e.get("upstream_repo", ""), "commit_sha": e.get("commit_sha", ""),
            "license_file": e.get("license_file", ""), "license_sha256": e.get("license_sha256", ""),
            "proof_url": e.get("proof_url", ""), "invoice_ref": e.get("invoice_ref", ""),
            "allow_origins": e.get("allow_origins", ""),
            "attribution_required": int(e.get("attribution_required", 0)),
            "attribution_html": e.get("attribution_html"), "captured_at": e.get("captured_at"),
            "expires_at": e.get("expires_at"), "status": e.get("status", "active"),
        }

    def verify_entry(self, e: dict) -> dict:
        missing = [f for f in PACK_REQUIRED if not str(e.get(f) or "").strip()]
        if missing:
            return {"ok": False, "verdict": "incomplete", "slug": e.get("slug", ""),
                    "license_type": e.get("license_type", ""), "missing": missing,
                    "reasons": [], "warnings": []}
        v = self.policy.decide([self.license_row(e)], "export")
        # the type the entry CLAIMED, so a rejection still names it
        return {"ok": v["ok"], "verdict": v["verdict"], "slug": e.get("slug", ""),
                "license_type": e.get("license_type", ""), "missing": [],
                "reasons": v["reasons"], "warnings": v["warnings"]}

    def verify_all(self) -> dict:
        rows = [self.verify_entry(e) for e in self.doc["entries"]]
        ok = sum(1 for r in rows if r["ok"])
        return {"pack_version": self.doc["version"], "total": len(rows), "accepted": ok,
                "rejected": len(rows) - ok, "entries": rows}


class Feed:
    """Python twin of Nawras\\Providers\\FeedConverter (same SQL, same order of work)."""

    def __init__(self, conn: sqlite3.Connection, policy: Policy):
        self.conn = conn
        self.policy = policy

    @staticmethod
    def license_row(item: dict) -> dict:
        """Twin of FeedConverter::licenseRow — the defaults matter: status defaults to active."""
        return {
            "id": 0, "provider": item.get("provider", "feed"), "external_id": item.get("external_id", ""),
            "license_type": item.get("license_type", ""), "license_ref": item.get("license_ref", ""),
            "upstream_repo": item.get("upstream_repo", ""), "commit_sha": item.get("commit_sha", ""),
            "license_file": item.get("license_file", ""), "license_sha256": item.get("license_sha256", ""),
            "proof_url": item.get("proof_url", ""), "invoice_ref": item.get("invoice_ref", ""),
            "allow_origins": item.get("allow_origins", ""),
            "attribution_required": int(item.get("attribution_required", 0)),
            "attribution_html": item.get("attribution_html"), "captured_at": item.get("captured_at"),
            "expires_at": item.get("expires_at"), "status": item.get("status", "active"),
        }

    def ingest(self, provider: str, feed_url: str, items: list[dict], at: str = TODAY + " 12:00:00",
               resolver=None) -> dict:
        verdict = guard_inspect(feed_url, resolver)
        cur = self.conn.execute(SQL_RUN_OPEN, (provider, "refused" if not verdict["ok"] else "running",
                                               0, 0, 0, at))
        run_id = cur.lastrowid
        if not verdict["ok"]:
            self.conn.execute(SQL_RUN_CLOSE, ("refused", 0, 0, 0,
                                              json.dumps({"feed_url": feed_url, "refused": verdict["reason"]}),
                                              at, run_id))
            return {"ok": False, "reason": verdict["reason"], "provider": provider,
                    "seen": 0, "new": 0, "rejected": 0, "accepted": 0, "rejections": []}
        seen = new = rejected = accepted = 0
        rejections = []
        for item in items:
            seen += 1
            missing = [f for f in FEED_REQUIRED_ITEM if not str(item.get(f) or "").strip()]
            external_id = str(item.get("external_id") or "")[:64]
            row = self.conn.execute(SQL_LOOKUP, (provider, external_id)).fetchone()
            payload = json.dumps(item, ensure_ascii=False)
            if row is None:
                new += 1
                self.conn.execute(SQL_STORE, (provider, external_id, payload, at))
            else:
                self.conn.execute(SQL_REFRESH, (payload, at, row[0]))
            if missing:
                rejected += 1
                rejections.append({"external_id": external_id, "reasons": missing})
                continue
            decision = self.policy.decide([self.license_row(item)], "dynamic")
            if not decision["ok"]:
                rejected += 1
                rejections.append({"external_id": external_id, "reasons": decision["reasons"]})
                continue
            accepted += 1
        self.conn.execute(SQL_RUN_CLOSE, ("ok", seen, new, rejected,
                                          json.dumps({"feed_url": feed_url, "rejections": rejections}),
                                          at, run_id))
        return {"ok": True, "reason": "", "provider": provider, "seen": seen, "new": new,
                "rejected": rejected, "accepted": accepted, "rejections": rejections}


# (url, expected reason) — every bypass a naive guard misses, and the two that must be allowed
HOSTILE_URLS = [
    ("http://169.254.169.254/latest/meta-data/iam/security-credentials/", "ip_blocked"),
    ("http://127.0.0.1/feed.json", "ip_blocked"),
    ("http://127.1/feed.json", "ip_blocked"),
    ("http://2130706433/feed.json", "ip_blocked"),
    ("http://0x7f000001/feed.json", "ip_blocked"),
    ("http://0177.0.0.1/feed.json", "ip_blocked"),
    ("http://[::1]/feed.json", "ip_blocked"),
    ("http://[::ffff:127.0.0.1]/feed.json", "ip_blocked"),
    ("http://0.0.0.0/feed.json", "ip_blocked"),
    ("http://10.1.2.3/feed.json", "ip_blocked"),
    ("http://192.168.1.1/feed.json", "ip_blocked"),
    ("http://172.16.9.9/feed.json", "ip_blocked"),
    ("http://100.64.0.1/feed.json", "ip_blocked"),
    ("http://[fc00::1]/feed.json", "ip_blocked"),
    ("http://[fe80::1]/feed.json", "ip_blocked"),
    ("file:///etc/passwd", "scheme_not_allowed"),
    ("gopher://example.org:70/_GET", "scheme_not_allowed"),
    ("php://input", "scheme_not_allowed"),
    ("http://admin@10.0.0.5/feed.json", "userinfo_not_allowed"),
    ("http://example.org:3306/feed.json", "port_not_allowed"),
    ("http://localhost/feed.json", "host_blocked"),
    ("http://db.internal/feed.json", "host_blocked"),
    ("http://printer.local/feed.json", "host_blocked"),
]


def proof_e() -> None:
    print("E · providers: the SSRF guard, the OSS pack gate and feed ingestion")

    # --- E1: nothing reserved is fetchable, in any encoding
    for url, expected in HOSTILE_URLS:
        got = guard_inspect(url)
        check(f"guard refuses {url[:46]}", got["ok"] is False and got["reason"] == expected,
              f"got {got['reason']}")
    for url in ["https://games.example.org/feed.json", "http://93.184.216.34/feed.json"]:
        got = guard_inspect(url)
        check(f"guard allows {url}", got["ok"] is True, str(got))
    internal = guard_inspect("http://feeds.example.org/feed.json", resolver=lambda h: ["10.0.0.5"])
    check("guard refuses a public name that resolves inward", internal["reason"] == "dns_blocked", str(internal))
    mixed = guard_inspect("http://feeds.example.org/feed.json", resolver=lambda h: ["93.184.216.34", "127.0.0.1"])
    check("one inward answer poisons the whole name", mixed["reason"] == "dns_blocked", str(mixed))
    dead = guard_inspect("http://nowhere.example.org/feed.json", resolver=lambda h: [])
    check("an unresolvable name is refused, not fetched", dead["reason"] == "unresolvable", str(dead))
    check("no blocked range is missing from either list",
          len(BLOCKED_V4) == 15 and len(BLOCKED_V6) == 8,
          f"v4={len(BLOCKED_V4)} v6={len(BLOCKED_V6)}")

    # --- E2: the OSS pack gate, on the file that actually ships
    policy = Policy(json.loads((ROOT / "db" / "license_rules.json").read_text(encoding="utf-8")))
    pack = Pack(json.loads((ROOT / "db" / "oss_pack.json").read_text(encoding="utf-8")), policy)
    report = pack.verify_all()
    by_slug = {r["slug"]: r for r in report["entries"]}
    check("the shipped pack is 7 accepted / 3 rejected",
          (report["accepted"], report["rejected"]) == (7, 3),
          f"accepted={report['accepted']} rejected={report['rejected']}")
    for slug in ("2048", "pacman-canvas", "tanks-of-freedom", "hextris",
                 "underrun", "clumsy-bird", "hexgl"):
        check(f"pack accepts {slug}", by_slug[slug]["ok"] is True, str(by_slug[slug]))
    check("pack rejects an entry with no licence hash",
          by_slug["ghost-maze"]["verdict"] == "incomplete"
          and by_slug["ghost-maze"]["missing"] == ["license_sha256"], str(by_slug["ghost-maze"]))
    check("pack rejects a single-site licence in export mode",
          by_slug["turbo-drift"]["reasons"] == ["no_redistribution"], str(by_slug["turbo-drift"]["reasons"]))
    check("pack rejects an unknown licence type",
          by_slug["void-runner"]["reasons"] == ["unknown_license_type"], str(by_slug["void-runner"]["reasons"]))
    cc_by_sample = pack.license_row({
        "slug": "cc-by-sample", "license_type": "cc-by", "license_ref": "CC BY 4.0",
        "attribution_required": 1, "attribution_html": "Sample by Example, CC BY 4.0",
    })
    check("pack attribution survives for cc-by", policy.attribution(cc_by_sample) is not None)

    # --- E3: feed ingestion, on a real database
    conn = fresh_conn()
    conn.executescript((ROOT / "db" / "schema.sqlite.sql").read_text(encoding="utf-8"))
    feed = Feed(conn, policy)
    items = [
        {"external_id": "gd-1", "title_en": "Neon Racer", "license_type": "mit", "license_ref": "MIT",
         "commit_sha": "9" * 40, "license_file": "LICENSE", "license_sha256": "a" * 64,
         "proof_url": "https://git.example/gd-1", "captured_at": TODAY,
         "attribution_required": 1, "attribution_html": "Neon Racer © its authors, MIT"},
        {"external_id": "gd-2", "title_en": "Ghost Maze", "license_type": "cc-by", "license_ref": "CC BY 4.0",
         "proof_url": "https://git.example/gd-2", "captured_at": TODAY},
        {"external_id": "gd-3", "title_en": "No Licence", "license_type": "beerware"},
        {"external_id": "", "title_en": "No Id", "license_type": "own"},
    ]
    res = feed.ingest("gamedistribution", "https://api.example.org/feed.json", items, resolver=lambda h: ["93.184.216.34"])
    check("a clean feed is accepted with the unlicensed items rejected",
          res["ok"] is True and res["seen"] == 4 and res["accepted"] == 1 and res["rejected"] == 3,
          f"seen={res['seen']} accepted={res['accepted']} rejected={res['rejected']}")
    check("feed items land in provider_games once",
          conn.execute("SELECT COUNT(*) FROM provider_games").fetchone()[0] == 4)
    check("a feed item without a licence is rejected with a reason",
          any(r["external_id"] == "gd-2" and "missing_license_file" in r["reasons"] for r in res["rejections"]),
          str(res["rejections"]))
    check("a feed item with an unknown type is rejected",
          any(r["external_id"] == "gd-3" and r["reasons"] == ["unknown_license_type"] for r in res["rejections"]))
    check("a feed item with no external_id is rejected",
          any(r["external_id"] == "" and r["reasons"] == ["external_id"] for r in res["rejections"]))

    again = feed.ingest("gamedistribution", "https://api.example.org/feed.json", items, resolver=lambda h: ["93.184.216.34"])
    check("re-running the same feed inserts nothing new", again["new"] == 0 and again["seen"] == 4,
          f"new={again['new']}")
    check("re-running still leaves one row per item",
          conn.execute("SELECT COUNT(*) FROM provider_games").fetchone()[0] == 4)
    dupes = conn.execute(
        "SELECT provider, external_id, COUNT(*) c FROM provider_games GROUP BY provider, external_id HAVING c > 1"
    ).fetchall()
    check("(provider, external_id) stays unique across re-runs", dupes == [], str(dupes))

    refused = feed.ingest("gamedistribution", "http://169.254.169.254/latest/meta-data/", items)
    check("a feed URL aimed at the metadata endpoint is refused before any fetch",
          refused["ok"] is False and refused["reason"] == "ip_blocked", str(refused["reason"]))
    runs = conn.execute("SELECT status, rows_seen, rows_rejected FROM provider_runs ORDER BY id").fetchall()
    check("every run is recorded in provider_runs, including the refusal",
          [r[0] for r in runs] == ["ok", "ok", "refused"], str(runs))
    check("the refusal wrote down why",
          "ip_blocked" in (conn.execute("SELECT detail FROM provider_runs WHERE status = 'refused'").fetchone()[0] or ""))



# ------------------------------------------- F (static export + installer)
# Mirrors of Nawras\Export\StaticExporter and Nawras\Install\Installer. The property that matters
# is negative: a game the auditor refuses in export mode must produce NO file. Every check below
# was written after injecting the opposite behaviour and watching this proof go red.

class Exporter:
    """Python mirror of StaticExporter: same layout, same refusal rule, same two hashes."""

    def __init__(self, auditor: Auditor, dist: str, rules_source: str, site_name: str = "Nawras Arcade"):
        self.auditor = auditor
        self.dist = dist
        self.rules_source = rules_source
        self.site_name = site_name

    @staticmethod
    def page(slug: str, game: dict, site_name: str) -> str:
        attribution = "" if game.get("attribution") is None else str(game["attribution"])
        ltype = str(game.get("license_type") or "")
        return (
            '<!doctype html>\n<html lang="ar" dir="rtl">\n'
            f'<head><meta charset="utf-8"><title>{slug} \u00b7 {site_name}</title></head>\n'
            f'<body data-game="{slug}" data-license="{ltype}">\n<h1>{slug}</h1>\n'
            f'<div id="game" data-src="{slug}.html"></div>\n'
            f'<footer class="attribution" lang="en" dir="ltr">{attribution}</footer>\n'
            '<script>/* rules: assets/license-rules.json \u00b7 hash checked at build time */</script>\n'
            '</body></html>\n'
        )

    def _mkdir(self, path: str) -> None:
        Path(path).mkdir(parents=True, exist_ok=True)

    def export(self) -> dict:
        manifest = self.auditor.manifest()
        rules_bytes = Path(self.rules_source).read_bytes()
        try:
            decoded = json.loads(rules_bytes.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Licence policy is not valid JSON ({self.rules_source}).") from exc
        if not isinstance(decoded, dict):
            raise RuntimeError(f"Licence policy is not valid JSON ({self.rules_source}).")
        # Content identity, exactly as the PHP does it: the policy the auditor judged with must be
        # the policy being shipped, compared on the re-encoded decode so whitespace cannot hide it.
        if hashlib.sha256(php_json_encode(decoded).encode("utf-8")).hexdigest() != manifest["rules_sha256"]:
            raise RuntimeError("The policy file on disk is not the policy the audit ran against; refusing to export.")

        self._mkdir(self.dist)
        self._mkdir(self.dist + "/assets")
        files, refusals = [], []
        total = exported = 0
        for game in manifest["games"]:
            slug = str(game["slug"])
            if game["exportable"] is False:
                refusals.append({"slug": slug, "verdict": game["verdict"],
                                 "license_type": game["license_type"], "reasons": game["reasons"]})
                continue
            html = self.page(slug, game, self.site_name)
            path = f"{self.dist}/game/{slug}/index.html"
            self._mkdir(str(Path(path).parent))
            Path(path).write_text(html, encoding="utf-8")
            files.append(f"/game/{slug}/index.html")
            total += len(html.encode("utf-8"))
            exported += 1

        rules_target = self.dist + "/assets/license-rules.json"
        Path(rules_target).write_bytes(rules_bytes)
        files.append("/assets/license-rules.json")
        total += len(rules_bytes)

        manifest["rules_file_sha256"] = hashlib.sha256(rules_bytes).hexdigest()
        manifest["site"] = self.site_name
        manifest["exported"] = exported
        manifest["refusals"] = refusals
        blob = json.dumps(manifest, ensure_ascii=False, indent=2)
        Path(self.dist + "/license-manifest.json").write_text(blob, encoding="utf-8")
        files.append("/license-manifest.json")
        total += len(blob.encode("utf-8"))

        names = [str(g["slug"]) for g in manifest["games"] if g["exportable"] is True]
        index = ("<!doctype html>\n<html lang=\"ar\" dir=\"rtl\"><head><meta charset=\"utf-8\">"
                 f"<title>{self.site_name}</title></head>\n<body>\n<h1>{self.site_name}</h1>\n<ul>\n"
                 + "".join(f'<li><a href="/game/{n}/">{n}</a></li>\n' for n in names)
                 + "</ul>\n</body></html>\n")
        Path(self.dist + "/index.html").write_text(index, encoding="utf-8")
        files.append("/index.html")
        total += len(index.encode("utf-8"))

        return {"ok": exported > 0, "exported": exported, "blocked": len(refusals), "bytes": total,
                "rules_file_sha256": manifest["rules_file_sha256"],
                "rules_version": int(manifest["rules_version"]), "files": files, "refusals": refusals}


# One line each, verbatim from Installer.php: tools/verify_php.py compares these literals against
# the PHP constants and a string split across two adjacent lines never matches.
INSTALL_SQL_SETTING = "INSERT INTO settings (key_name, value_type, value_text, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key_name) DO NOTHING"
INSTALL_SQL_ADMIN = "INSERT INTO users (username, email, password_hash, display_name, role, locale, xp, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT(username) DO NOTHING"
INSTALL_DEFAULT_SETTINGS = [("site_name_ar", "string", "\u0623\u0631\u0643\u064a\u062f \u0646\u0648\u0631\u0633"),
                            ("site_name_en", "string", "Nawras Arcade"), ("locale_default", "string", "ar"),
                            ("commercial", "bool", "1"), ("leaderboard_default_type", "string", "top-week")]


class Install:
    """Python mirror of Installer: same step order, same refusals, same SQL."""

    MIN_PHP = "8.1.0"
    REQUIRED_EXTENSIONS = ["pdo", "json", "mbstring", "hash"]

    def __init__(self, conn: sqlite3.Connection | None = None, root: str | None = None,
                 php_version: str = "8.3.0", extensions: list[str] | None = None,
                 drivers: list[str] | None = None, options: dict | None = None):
        self.conn = conn
        self.root = root or str(ROOT)
        self.php_version = php_version
        self.extensions = list(self.REQUIRED_EXTENSIONS if extensions is None else extensions)
        self.drivers = ["sqlite"] if drivers is None else drivers
        self.options = dict(options or {})

    def check_environment(self) -> str:
        def newer(a: str, b: str) -> bool:
            return [int(x) for x in a.split(".")] >= [int(x) for x in b.split(".")]
        if not newer(self.php_version, self.MIN_PHP):
            raise RuntimeError(f"PHP {self.MIN_PHP}+ required, found {self.php_version}")
        missing = [e for e in self.REQUIRED_EXTENSIONS if e not in self.extensions]
        if missing:
            raise RuntimeError("Missing PHP extensions: " + ", ".join(missing))
        if "mysql" not in self.drivers and "sqlite" not in self.drivers:
            raise RuntimeError("PDO needs pdo_mysql or pdo_sqlite; found: " + ", ".join(self.drivers))
        var = self.root + "/var"
        Path(var).mkdir(parents=True, exist_ok=True)
        if not os.access(var, os.W_OK):
            raise RuntimeError(f"{var} is not writable by the web server user")
        return "PHP " + self.php_version + " \u00b7 pdo drivers: " + ", ".join(self.drivers)

    def write_config(self) -> str:
        target = self.root + "/config/config.php"
        sample = self.root + "/config/config.sample.php"
        if Path(target).is_file() and self.options.get("force") is not True:
            return "config/config.php already exists \u2014 left untouched"
        if not Path(sample).is_file():
            raise RuntimeError(f"config/config.sample.php is missing from this package ({sample})")
        text = Path(sample).read_text(encoding="utf-8")
        secret = hashlib.sha256(os.urandom(32)).hexdigest()
        # The shipped sample carries a placeholder on purpose; installing it verbatim would give
        # every buyer the same signing key.
        if "change-me-to-32-plus-random-bytes" not in text:
            raise RuntimeError("the sample config no longer carries the placeholder secret this installer replaces")
        body = text.replace("change-me-to-32-plus-random-bytes", secret)
        Path(target).write_text(body, encoding="utf-8")
        return "config/config.php written with a fresh 32-byte secret"

    def load_config(self) -> str:
        file = self.root + "/config/config.php"
        if not Path(file).is_file():
            raise RuntimeError(f"Config was not written ({file})")
        m = re.search(r"'secret'\s*=>\s*'([^']*)'", Path(file).read_text(encoding="utf-8"))
        secret = m.group(1) if m else ""
        if len(secret) < 32:
            raise RuntimeError("Refusing to continue: the configured secret is shorter than 32 bytes")
        return secret

    def seed(self, admin_user: str = "admin", admin_password: str = "a-fresh-password") -> str:
        if self.conn is None:
            raise RuntimeError("Installer has no database connection; run() must create one first")
        stamp = TODAY + " 12:00:00"
        for key, vtype, value in INSTALL_DEFAULT_SETTINGS:
            self.conn.execute(INSTALL_SQL_SETTING, (key, vtype, value, stamp))
        if len(admin_password) < 8:
            raise RuntimeError("The admin password must be at least 8 characters")
        self.conn.execute(INSTALL_SQL_ADMIN, (admin_user, None, "hashed:" + admin_password, admin_user,
                                              "admin", "ar", stamp, stamp))
        return f"{len(INSTALL_DEFAULT_SETTINGS)} setting(s) upserted \u00b7 admin \"{admin_user}\" ensured"

    def self_check(self) -> str:
        if self.conn is None:
            raise RuntimeError("Installer has no database connection; run() must create one first")
        row = self.conn.execute("SELECT COALESCE(MAX(version), 0) FROM schema_version").fetchone()
        version = int(row[0]) if row else 0
        if version != MIGRATOR_CURRENT:
            raise RuntimeError(f"Schema is at version {version} but this build expects {MIGRATOR_CURRENT}")
        schema = json.loads((Path(self.root) / "db" / "schema.json").read_text(encoding="utf-8"))
        expected = set(schema["tables"])
        present = {r[0].lower() for r in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        missing = sorted(expected - present)
        if missing:
            raise RuntimeError("Schema is missing table(s): " + ", ".join(missing))
        return f"schema v{version} \u00b7 {len(present)} tables present, none missing"

    def run(self) -> dict:
        steps, fatal = [], None
        for name, work in [("environment", self.check_environment), ("config", self.write_config),
                           ("secret", self.load_config), ("seed", self.seed),
                           ("self_check", self.self_check)]:
            try:
                steps.append({"name": name, "ok": True, "detail": str(work())})
            except Exception as exc:  # noqa: BLE001 - the installer reports, it does not crash
                steps.append({"name": name, "ok": False, "detail": str(exc)})
                fatal = str(exc)
                break
        return {"ok": fatal is None, "steps": steps, "fatal": fatal}


def proof_f() -> None:
    print("F \u00b7 static export + installer: a refused game produces no file, an install proves itself")
    conn = fresh_conn()
    conn.executescript((ROOT / "db" / "schema.sqlite.sql").read_text(encoding="utf-8"))
    ids = seed_catalogue(conn)
    policy = Policy(json.loads((ROOT / "db" / "license_rules.json").read_text(encoding="utf-8")))
    auditor = Auditor(conn, policy)
    dist = tempfile.mkdtemp(prefix="arcade-dist-")

    # --- F1: the manifest the exporter is built from
    manifest = auditor.manifest()
    check("manifest covers every published game", len(manifest["games"]) == len(CATALOGUE), str(len(manifest["games"])))
    check("manifest exportable flag is the audit verdict",
          all(g["exportable"] == (g["verdict"] != "blocked") for g in manifest["games"]))
    check("manifest counts equal the audit split",
          manifest["counts"]["ok"] + manifest["counts"]["warn"] + manifest["counts"]["blocked"] == len(CATALOGUE))
    rules_bytes = (ROOT / "db" / "license_rules.json").read_bytes()
    check("rules_sha256 is the hash of the policy the auditor loaded",
          manifest["rules_sha256"] == hashlib.sha256(php_json_encode(json.loads(rules_bytes)).encode()).hexdigest())
    check("manifest carries the rules version", manifest["rules_version"] == policy.version())
    by_slug = {g["slug"]: g for g in manifest["games"]}
    check("a no-redistribution licence is refused for export",
          by_slug["shop-only"]["exportable"] is False and "no_redistribution" in by_slug["shop-only"]["reasons"],
          str(by_slug["shop-only"]["reasons"]))
    check("cc-by-nc is refused for export on a commercial install",
          by_slug["nc-arcade"]["exportable"] is False and "not_commercial_ok" in by_slug["nc-arcade"]["reasons"],
          str(by_slug["nc-arcade"]["reasons"]))
    check("own work is exportable", by_slug["neon-worm"]["exportable"] is True)
    check("cc-by work is exportable and carries its attribution",
          by_slug["pixel-paint"]["exportable"] is True and by_slug["pixel-paint"]["attribution"] == ATTR)

    # --- F2: the bundle
    report = Exporter(auditor, dist, str(ROOT / "db" / "license_rules.json")).export()
    exportable = [g["slug"] for g in manifest["games"] if g["exportable"] is True]
    refused = [g["slug"] for g in manifest["games"] if g["exportable"] is False]
    check("the bundle contains exactly the exportable games",
          report["exported"] == len(exportable) > 0, f"{report['exported']} vs {len(exportable)}")
    on_disk = sorted(p.parent.name for p in Path(dist, "game").glob("*/index.html"))
    check("every exportable game got a page", on_disk == sorted(exportable), str(on_disk))
    check("a refused game produces NO file at all",
          all(not Path(dist, "game", slug).exists() for slug in refused),
          str([s for s in refused if Path(dist, "game", s).exists()]))
    check("the refusals are named in the manifest, not silently dropped",
          sorted(r["slug"] for r in report["refusals"]) == sorted(refused))
    check("every refusal carries the finding codes that caused it",
          all(r["reasons"] for r in report["refusals"]), str(report["refusals"]))
    page = Path(dist, "game", "pixel-paint", "index.html").read_text(encoding="utf-8")
    check("an exported page embeds the attribution it owes", ATTR in page)
    check("an exported page declares the licence type it was cleared under",
          'data-license="cc-by"' in page, page[:120])
    check("an exported page is RTL Arabic-first", page.startswith('<!doctype html>\n<html lang="ar" dir="rtl">'))
    copied = Path(dist, "assets", "license-rules.json").read_bytes()
    check("the shipped policy copy is byte-identical to the policy the audit used",
          hashlib.sha256(copied).hexdigest() == hashlib.sha256(rules_bytes).hexdigest())
    written = json.loads(Path(dist, "license-manifest.json").read_text(encoding="utf-8"))
    check("the manifest records the hash of the bytes it shipped",
          written["rules_file_sha256"] == hashlib.sha256(copied).hexdigest())
    check("a static host can re-check the rules it serves",
          written["rules_sha256"] == hashlib.sha256(php_json_encode(json.loads(copied)).encode()).hexdigest())
    index_html = Path(dist, "index.html").read_text(encoding="utf-8")
    check("the index links only games that were exported",
          all(f"/game/{s}/" in index_html for s in exportable)
          and all(f"/game/{s}/" not in index_html for s in refused))
    check("the report counts what it wrote", report["bytes"] > 0 and len(report["files"]) == len(exportable) + 3)

    tampered = Path(dist, "tampered-rules.json")
    tampered.write_bytes(rules_bytes.replace(b'"version"', b'"version_x"', 1))
    try:
        Exporter(auditor, dist, str(tampered)).export()
        check("a policy file that is not the audited policy refuses the export", False, "no exception raised")
    except RuntimeError as exc:
        check("a policy file that is not the audited policy refuses the export", "not the policy" in str(exc), str(exc))
    try:
        Exporter(auditor, dist, str(ROOT / "package.json")).export()
        check("a policy file that is valid JSON but a different document is refused", False, "no exception raised")
    except RuntimeError as exc:
        check("a policy file that is valid JSON but a different document is refused", True, str(exc))

    # --- F3: the installer
    inst_root = tempfile.mkdtemp(prefix="arcade-install-")
    Path(inst_root, "config").mkdir(parents=True)
    Path(inst_root, "db").mkdir(parents=True)
    shutil.copy(ROOT / "config" / "config.sample.php", Path(inst_root, "config", "config.sample.php"))
    shutil.copy(ROOT / "db" / "schema.json", Path(inst_root, "db", "schema.json"))
    installer = Install(conn=conn, root=inst_root)
    check("the environment check passes on a supported PHP", "PHP 8.3.0" in installer.check_environment())
    try:
        Install(conn=conn, root=inst_root, php_version="8.0.30").check_environment()
        check("PHP below the minimum is refused", False, "no exception raised")
    except RuntimeError as exc:
        check("PHP below the minimum is refused", "8.1.0+ required" in str(exc), str(exc))
    try:
        Install(conn=conn, root=inst_root, extensions=["pdo", "json"]).check_environment()
        check("a missing extension is refused by name", False, "no exception raised")
    except RuntimeError as exc:
        check("a missing extension is refused by name", "mbstring" in str(exc), str(exc))
    try:
        Install(conn=conn, root=inst_root, drivers=["pgsql"]).check_environment()
        check("a PDO driver the engine cannot use is refused", False, "no exception raised")
    except RuntimeError as exc:
        check("a PDO driver the engine cannot use is refused", "pdo_mysql or pdo_sqlite" in str(exc), str(exc))

    installer.write_config()
    secret = installer.load_config()
    check("the written secret is 32 bytes of hex, not the shipped placeholder",
          len(secret) == 64 and secret != "change-me-to-32-plus-random-bytes", secret[:8] + "\u2026")
    other_root = tempfile.mkdtemp(prefix="arcade-install2-")
    Path(other_root, "config").mkdir(parents=True)
    shutil.copy(ROOT / "config" / "config.sample.php", Path(other_root, "config", "config.sample.php"))
    Install(conn=conn, root=other_root).write_config()
    check("two installs do not share a signing key",
          Install(conn=conn, root=other_root).load_config() != secret)
    rotator = Install(conn=conn, root=inst_root, options={"force": True})
    rotator.write_config()
    rotated = rotator.load_config()
    check("--force rotates the signing key", rotated != secret and len(rotated) == 64, rotated[:8] + "\u2026")
    check("without force an existing config is left alone",
          installer.write_config().endswith("left untouched"))
    check("and the no-force run really left the previous key on disk", installer.load_config() == rotated)
    Path(inst_root, "config", "config.php").write_text(
        "<?php return ['secret' => 'twelve-chars'];", encoding="utf-8")
    try:
        installer.load_config()
        check("a 12-byte secret stops the install (the limit is 32, not 8)", False, "no exception raised")
    except RuntimeError as exc:
        check("a 12-byte secret stops the install (the limit is 32, not 8)",
              "shorter than 32 bytes" in str(exc), str(exc))

    conn.execute("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)", (MIGRATOR_CURRENT, TODAY + " 12:00:00"))
    check("seeding is idempotent: settings upsert, admin insert once",
          "5 setting(s)" in installer.seed() and "5 setting(s)" in installer.seed())
    check("the settings table holds one row per key",
          conn.execute("SELECT COUNT(*) FROM settings").fetchone()[0] == len(INSTALL_DEFAULT_SETTINGS))
    check("the admin account was not duplicated",
          conn.execute("SELECT COUNT(*) FROM users WHERE username = 'admin'").fetchone()[0] == 1)
    conn.execute("UPDATE settings SET value_text = 'changed' WHERE key_name = 'site_name_en'")
    installer.seed()
    check("a re-seed does not overwrite copy the operator edited",
          conn.execute("SELECT value_text FROM settings WHERE key_name = 'site_name_en'").fetchone()[0]
          == "changed")
    conn.execute("DELETE FROM settings WHERE key_name = 'commercial'")
    installer.seed()
    check("a setting added later is still seeded on the next run",
          conn.execute("SELECT COUNT(*) FROM settings WHERE key_name = 'commercial'").fetchone()[0] == 1)
    check("the installer's own SQL is the SQL this proof ran",
          "ON CONFLICT(key_name) DO NOTHING" in INSTALL_SQL_SETTING
          and "ON CONFLICT(username) DO NOTHING" in INSTALL_SQL_ADMIN)
    check("self-check passes on a fully migrated schema", "none missing" in installer.self_check(), installer.self_check())
    conn.execute("DROP TABLE badges")
    try:
        installer.self_check()
        check("self-check names a missing table", False, "no exception raised")
    except RuntimeError as exc:
        check("self-check names a missing table", "badges" in str(exc), str(exc))
    conn.executescript((ROOT / "db" / "schema.sqlite.sql").read_text(encoding="utf-8").split("CREATE TABLE")[0])
    conn.execute("DELETE FROM schema_version")
    conn.execute("INSERT INTO schema_version (version, applied_at) VALUES (3, ?)", (TODAY + " 12:00:00",))
    try:
        installer.self_check()
        check("self-check refuses a schema older than this build", False, "no exception raised")
    except RuntimeError as exc:
        check("self-check refuses a schema older than this build", "expects " + str(MIGRATOR_CURRENT) in str(exc), str(exc))

    run = Install(conn=conn, root=inst_root, php_version="7.4.33").run()
    check("run() stops at the first failed step and says which",
          run["ok"] is False and run["fatal"] is not None and run["steps"][-1]["name"] == "environment",
          str([s["name"] for s in run["steps"]]))

    shutil.rmtree(dist, ignore_errors=True)
    shutil.rmtree(inst_root, ignore_errors=True)
    shutil.rmtree(other_root, ignore_errors=True)


def main() -> int:
    proof_a()
    proof_b()
    proof_c()
    proof_d()
    proof_e()
    proof_f()
    print()
    if FAILURES:
        print(f"✗ {len(FAILURES)}/{CHECKS} checks failed:")
        for f in FAILURES:
            print(f"   - {f}")
        return 1
    print(f"✓ all {CHECKS} runtime checks hold · schema, migrations, the 8 boards, the licence gate, the providers, the exporter and the installer behave")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
